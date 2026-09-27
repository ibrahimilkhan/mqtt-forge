using System.Diagnostics;
using System.Text;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Time.Testing;
using MqttForge.Application.Alerts;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Exceptions;
using MqttForge.Domain.Models;
using MqttForge.Infrastructure.Alerts;
using MqttForge.UnitTests.Application.Alerts;
using Xunit;

namespace MqttForge.UnitTests.Infrastructure;

/// <summary>
/// The fourth channel: the alert, published back to the broker it came from.
///
/// Two things make this channel different from the other three. It writes to the same broker the
/// engine is subscribed to, so a mistake here is not a lost message but a feedback loop; and it
/// leaves a retained record behind, so a mistake here outlives the process that made it.
/// </summary>
public class MqttAlertDispatcherTests
{
    private static readonly DateTimeOffset T0 = new(2026, 8, 30, 9, 0, 0, TimeSpan.Zero);

    private const string Prefix = "mqttforge/alerts/";

    private readonly RecordingPublisher _publisher = new();
    private readonly RecordingLogger<MqttAlertDispatcher> _log = new();
    private readonly FakeLifetime _lifetime = new();
    private readonly AlertEngineOptions _options = new() { TopicPrefix = Prefix };

    private MqttAlertDispatcher CreateSut() =>
        new(_publisher, _options, _log, _lifetime);

    private static Alert Fired(
        PublishAction? publish = null,
        string @event = "raised",
        string ruleId = "r1",
        string topic = "plant/boiler/temp",
        IReadOnlyList<AlertAction>? actions = null) =>
        new($"a-{ruleId}-{topic}", ruleId, "Boiler temperature", topic, AlertSeverity.Critical,
            FiredAt: T0, LastSeenAt: T0,
            ResolvedAt: @event == "resolved" ? T0 : null,
            ResolvedBy: @event == "resolved" ? "clear" : null,
            MutedUntil: null, Count: 1, Reason: "94.2 > 90", Value: 94.2,
            Sample: "{\"temp\":94.2}",
            Actions: actions ?? [publish ?? new PublishAction(null, 0, false)]);

    private static string TextOf(PublishRequest request) => Encoding.UTF8.GetString(request.Payload);

    private static async Task Until(Func<bool> settled, string what, TimeSpan? patience = null)
    {
        var deadline = DateTime.UtcNow + (patience ?? TimeSpan.FromSeconds(10));

        while (DateTime.UtcNow < deadline)
        {
            if (settled()) return;
            await Task.Delay(5);
        }

        Assert.Fail($"Timed out waiting until {what}.");
    }

    /// <summary>Waits until everything handed over has been published or given up on.</summary>
    private static Task Settled(MqttAlertDispatcher sut) => Until(() => sut.Pending == 0, "every alarm to be published");

    private static Alert Ended(Alert alert) => alert with { ResolvedAt = T0, ResolvedBy = "clear" };

    // ---- a broker slow to take a publish ----

    // Both engines hand their alarms over on their pumps — the alert rules' and the flows' — so a
    // publish awaited here was every rule and every flow waiting with it: two seconds an alarm at
    // worst, and four for a retained one's end, which is the body and then the clear.
    [Fact]
    public async Task A_broker_slow_to_take_a_publish_holds_up_no_caller()
    {
        _publisher.Stall = true;
        var sut = CreateSut();
        var action = new PublishAction(null, 1, true);

        var raising = sut.RaisedAsync([Fired(action)]);
        var ending = sut.ResolvedAsync([Ended(Fired(action))]);

        Assert.True(raising.IsCompleted, "the raise waited on the broker");
        Assert.True(ending.IsCompleted, "the end waited on the broker");

        _publisher.Stall = false;
        await Settled(sut);
    }

    // What the bug looked like from the outside: an engine whose pump handed its alarms to a broker
    // slow to take them judged nothing else meanwhile, two seconds an alarm — the flows' engine too,
    // which shares this channel.
    [Fact]
    public async Task A_broker_slow_to_take_alarms_holds_up_no_rule()
    {
        _publisher.Stall = true;
        var time = new FakeTimeProvider(T0);
        var told = new RecordingAlertNotifier();
        var rule = new AlertRule("r1", "Boiler temperature", Enabled: true, "plant/+/temp", Field: null,
            new ThresholdCondition(ThresholdOp.Gt, 90), Clear: null, For: null, Cooldown: null,
            AlertSeverity.Critical, [new PublishAction(null, 1, true)]);
        var engine = new AlertEngine(
            new AlertEngineCore(_options),
            new FakeAlertRuleStore { Document = new AlertRuleDocument([rule], Unreadable: false, []) },
            new FakeAlertStateStore(), told, new FakeConnection { State = ConnectionState.Connected },
            new RecordingSubscriber(), new RecordingLogger<AlertEngine>(), time, CreateSut());
        await engine.StartAsync(CancellationToken.None);

        using var stop = new CancellationTokenSource();
        var pump = Task.Run(() => engine.RunAsync(stop.Token));
        try
        {
            // Five boilers ring at once: five publications for a broker that takes none of them.
            for (var i = 0; i < 5; i++)
                engine.Post(new ArrivalCommand(new MqttMessage($"plant/boiler-{i}/temp", "95", "text", 0, false, T0)));
            await Until(() => _publisher.Held == 1, "the first publication to be waiting on the broker");

            engine.Post(new ArrivalCommand(new MqttMessage("plant/kiln/temp", "95", "text", 0, false, T0)));

            // Well inside the ten seconds the five would hold a pump that waited on them.
            await Until(() => told.Raised.Count == 6, "the next reading to be judged", TimeSpan.FromSeconds(5));
        }
        finally
        {
            await stop.CancelAsync();
            await pump.WaitAsync(TimeSpan.FromSeconds(15));
        }
    }

    // What the broker knows an alarm by is its topic, so the order of one topic's publications is
    // the whole of what it says: an end and the next alarm on the same rule and topic published the
    // other way round would leave the broker saying the new alarm is over.
    [Fact]
    public async Task Alarms_waiting_on_a_slow_broker_are_published_in_the_order_they_happened()
    {
        _publisher.Stall = true;
        var sut = CreateSut();
        var action = new PublishAction(null, 1, true);
        var first = Fired(action) with { Id = "first" };
        var next = Fired(action) with { Id = "next" };

        await sut.RaisedAsync([first]);
        await Until(() => _publisher.Held == 1, "the first publication to be waiting on the broker");
        await sut.ResolvedAsync([Ended(first)]);
        await sut.RaisedAsync([next]);
        _publisher.Stall = false;

        await Settled(sut);
        Assert.Equal(
            [AlertPayload.For(first, "raised"), AlertPayload.For(Ended(first), "resolved"), "", AlertPayload.For(next, "raised")],
            _publisher.Sent.Select(TextOf));

        // And the record left on the broker is the alarm that stands, for the shutdown to take back.
        _publisher.Clear();
        _lifetime.StopApplication();
        Assert.Empty(TextOf(Assert.Single(_publisher.Sent)));
    }

    // A broker that stays slow while alarms keep coming is not kept an unbounded backlog. What goes
    // is what the broker never needed: an alarm that went up and came down while it waited, both
    // ends, which leaves the broker where publishing both would have left it.
    [Fact]
    public async Task Past_the_bound_the_alarms_that_came_and_went_meanwhile_are_not_published_and_are_said()
    {
        _publisher.Stall = true;
        var sut = CreateSut();
        var action = new PublishAction(null, 0, false);

        await sut.RaisedAsync([Fired(action, topic: "plant/stuck/temp")]);
        await Until(() => _publisher.Held == 1, "the first publication to be waiting on the broker");

        // Exactly the bound's worth of alarms that came and went, so the one that stands is what
        // takes it past: every one of them is still waiting at that moment.
        var flood = MqttAlertDispatcher.QueueCapacity / 2;
        for (var i = 0; i < flood; i++)
        {
            var brief = Fired(action, topic: $"plant/brief-{i}/temp");
            await sut.RaisedAsync([brief]);
            await sut.ResolvedAsync([Ended(brief)]);
        }

        await sut.RaisedAsync([Fired(action, topic: "plant/standing/temp")]);
        _publisher.Stall = false;

        await Settled(sut);
        Assert.Equal(
            ["mqttforge/alerts/r1/plant/stuck/temp", "mqttforge/alerts/r1/plant/standing/temp"],
            _publisher.Sent.Select(sent => sent.Topic));
        Assert.Contains(_log.Lines, line => line.Message.StartsWith($"{flood} alarms went up and came down"));
    }

    // Shutdown takes back every retained record this process left. A publication still waiting then
    // would only be one more record to chase, so none is made, and the one in flight is called off.
    [Fact]
    public async Task Shutdown_calls_off_the_publication_in_flight_and_makes_none_of_those_waiting()
    {
        _publisher.Stall = true;
        var sut = CreateSut();
        var action = new PublishAction(null, 1, true);

        await sut.RaisedAsync([Fired(action, ruleId: "r1")]);
        await Until(() => _publisher.Held == 1, "the first publication to be waiting on the broker");
        await sut.RaisedAsync([Fired(action, ruleId: "r2")]);

        _lifetime.StopApplication();

        Assert.Equal(0, _publisher.Held);
        Assert.Empty(_publisher.Sent);
        Assert.Contains(_log.Lines, line => line.Message.Contains("still waiting when MQTTForge stopped"));
    }

    // The alert's identity is the (rule, topic) pair, so the place it goes has to name the pair.
    // A topic naming the rule alone would send a hundred topics' alarms to one address, and with
    // retain the last writer would be the only one anybody ever sees.
    [Fact]
    public async Task The_default_topic_names_the_pair_and_not_just_the_rule()
    {
        var sut = CreateSut();

        await sut.RaisedAsync([Fired()]);
        await Settled(sut);

        Assert.Equal("mqttforge/alerts/r1/plant/boiler/temp",
            Assert.Single(_publisher.Sent).Topic);
    }

    [Fact]
    public async Task A_user_topic_expands_the_topic_placeholder()
    {
        var sut = CreateSut();

        await sut.RaisedAsync([
            Fired(new PublishAction("mqttforge/alerts/boiler/{topic}/state", 0, false))
        ]);
        await Settled(sut);

        Assert.Equal("mqttforge/alerts/boiler/plant/boiler/temp/state",
            Assert.Single(_publisher.Sent).Topic);
    }

    // The check that could not be done at save time. A topic that starts inside the prefix and
    // leaves it once the placeholder is filled in is the shape the loop guard exists for, and it
    // only exists after expansion.
    [Fact]
    public async Task A_user_topic_is_checked_against_the_prefix_after_expansion()
    {
        var sut = CreateSut();

        await sut.RaisedAsync([Fired(new PublishAction("{topic}/alarm", 0, false))]);
        await Settled(sut);

        Assert.Empty(_publisher.Sent);
        Assert.Equal(1, sut.Refused);
    }

    [Fact]
    public async Task A_topic_outside_the_prefix_publishes_nothing_and_says_why()
    {
        var sut = CreateSut();

        await sut.RaisedAsync([Fired(new PublishAction("plant/boiler/alarm", 0, false))]);
        await Settled(sut);

        Assert.Empty(_publisher.Sent);
        Assert.Equal(1, sut.Refused);
        Assert.Contains(_log.Lines, l => l.Message.Contains("outside the alert prefix"));
    }

    // One body for both outgoing channels. An endpoint reading MQTT and an endpoint reading a
    // webhook are the same endpoint often enough that two shapes would be two bugs.
    [Fact]
    public async Task The_body_is_the_same_body_the_webhook_sends()
    {
        var alert = Fired();
        var sut = CreateSut();

        await sut.RaisedAsync([alert]);
        await Settled(sut);

        Assert.Equal(AlertPayload.For(alert, "raised"), TextOf(Assert.Single(_publisher.Sent)));
    }

    [Fact]
    public async Task A_resolved_alert_carries_the_resolved_body()
    {
        var alert = Fired(@event: "resolved");
        var sut = CreateSut();

        await sut.ResolvedAsync([alert]);
        await Settled(sut);

        Assert.Equal(AlertPayload.For(alert, "resolved"), TextOf(Assert.Single(_publisher.Sent)));
    }

    [Fact]
    public async Task The_qos_and_the_retain_flag_come_from_the_action()
    {
        var sut = CreateSut();

        await sut.RaisedAsync([Fired(new PublishAction(null, 2, true))]);
        await Settled(sut);

        var sent = Assert.Single(_publisher.Sent);
        Assert.Equal(2, sent.Qos);
        Assert.True(sent.Retain);
    }

    // The retained record is a promise that has to be taken back. Two publishes, in this order:
    // the resolved body, so anybody listening hears it, and then nothing at all, so anybody
    // subscribing tomorrow is not told about an alarm that ended today.
    [Fact]
    public async Task A_retained_resolve_publishes_the_body_and_then_clears_the_record()
    {
        var action = new PublishAction(null, 1, true);
        var alert = Fired(action, "resolved");
        var sut = CreateSut();

        await sut.RaisedAsync([Fired(action)]);
        await Settled(sut);
        _publisher.Clear();

        await sut.ResolvedAsync([alert]);
        await Settled(sut);

        Assert.Equal(2, _publisher.Sent.Count);
        Assert.Equal(AlertPayload.For(alert, "resolved"), TextOf(_publisher.Sent[0]));

        var clear = _publisher.Sent[1];
        Assert.Equal(_publisher.Sent[0].Topic, clear.Topic);
        Assert.Empty(clear.Payload);
        Assert.True(clear.Retain);
        Assert.Equal(1, clear.Qos);
    }

    // Nothing was left behind, so there is nothing to take back.
    [Fact]
    public async Task An_unretained_resolve_is_a_single_publish()
    {
        var sut = CreateSut();

        await sut.RaisedAsync([Fired(new PublishAction(null, 0, false))]);
        await Settled(sut);
        _publisher.Clear();

        await sut.ResolvedAsync([Fired(new PublishAction(null, 0, false), "resolved")]);
        await Settled(sut);

        Assert.Single(_publisher.Sent);
    }

    // The spec is explicit: "Bağlantı kopukken publish hata sayılmaz: gönderilmez, kuyruğa
    // alınmaz, sayılır." An exception here would reach the engine's DeliverAsync and be logged as
    // a notifier fault, which is a sentence about the wrong thing.
    [Fact]
    public async Task A_disconnected_broker_is_counted_and_never_thrown()
    {
        _publisher.Throw = () => new NotConnectedException("Connect to a broker before publishing.");

        var sut = CreateSut();

        await sut.RaisedAsync([Fired()]);
        await Settled(sut);

        Assert.Equal(1, sut.Undelivered);
        Assert.Empty(_publisher.Sent);
    }

    [Fact]
    public async Task A_publish_that_never_left_does_not_stop_the_next_alert()
    {
        _publisher.Throw = () => new NotConnectedException("Connect to a broker before publishing.");

        var sut = CreateSut();

        await sut.RaisedAsync([Fired(ruleId: "r1"), Fired(ruleId: "r2")]);
        await Settled(sut);

        Assert.Equal(2, sut.Undelivered);
    }

    // The failure a disconnected broker is not: a socket that is open, so nothing throws, and dead,
    // so nothing answers either. MqttnetPublisher hands its token to MQTTnet and waits, and the
    // alarms go out one at a time — so a publish with no deadline on it is every alarm behind it
    // held for as long as that socket stays half open.
    //
    // The only test in this file that waits on the wall clock, and deliberately so: the deadline
    // is a real timer, because what it is guarding against is a call that is never coming back and
    // a fake clock nobody is left to move would guard against nothing at all. Two seconds.
    [Fact]
    public async Task A_publish_that_never_answers_is_given_up_on_and_counted()
    {
        _publisher.Hang = true;

        var sut = CreateSut();
        var clock = Stopwatch.StartNew();

        await sut.RaisedAsync([Fired()]);
        await Until(() => sut.Undelivered == 1, "the publish to be given up on");

        clock.Stop();

        Assert.Empty(_publisher.Sent);
        Assert.Contains(_log.Lines, l => l.Message.Contains("could not be published"));

        // It waited, and then it stopped waiting. The upper bound is loose on purpose — this is
        // an assertion that the wait ended at all, not a measurement of the budget.
        Assert.InRange(clock.Elapsed.TotalSeconds, 1.0, 15.0);
    }

    // The failure this hook exists for is not a crash: it is 'restart: unless-stopped' doing
    // exactly what it was told. An alarm that was ringing when the container went down would
    // otherwise hang on the broker saying 'critical' for ever.
    [Fact]
    public async Task Shutdown_clears_the_retained_record_of_every_alert_still_standing()
    {
        var sut = CreateSut();

        await sut.RaisedAsync([
            Fired(new PublishAction(null, 1, true), ruleId: "r1", topic: "plant/a"),
            Fired(new PublishAction(null, 1, true), ruleId: "r2", topic: "plant/b")
        ]);
        await Settled(sut);

        _publisher.Clear();
        _lifetime.StopApplication();

        Assert.Equal(2, _publisher.Sent.Count);
        Assert.All(_publisher.Sent, sent =>
        {
            Assert.Empty(sent.Payload);
            Assert.True(sent.Retain);
        });

        Assert.Contains(_publisher.Sent, s => s.Topic == "mqttforge/alerts/r1/plant/a");
        Assert.Contains(_publisher.Sent, s => s.Topic == "mqttforge/alerts/r2/plant/b");
    }

    [Fact]
    public async Task Shutdown_does_not_clear_an_alert_that_already_resolved()
    {
        var action = new PublishAction(null, 1, true);
        var sut = CreateSut();

        await sut.RaisedAsync([Fired(action)]);
        await sut.ResolvedAsync([Fired(action, "resolved")]);
        await Settled(sut);

        _publisher.Clear();
        _lifetime.StopApplication();

        Assert.Empty(_publisher.Sent);
    }

    [Fact]
    public async Task An_alert_with_no_publish_action_publishes_nothing()
    {
        var sut = CreateSut();

        await sut.RaisedAsync([Fired(actions: [new ScreenAction(), new SoundAction()])]);

        // Not even handed over: there is nothing for the loop to do with it.
        Assert.Equal(0, sut.Pending);
        Assert.Empty(_publisher.Sent);
    }

    /// <summary>
    /// The round trip, closed on purpose and found not to close: whatever this dispatcher
    /// publishes, the engine will not judge.
    /// </summary>
    // The guard itself is in the core and has its own test there. This one is the join: it takes
    // the topic this class actually produces — not a topic a test author typed out believing it
    // is what the class produces — and feeds it to a core holding the greediest rule there is.
    // The two halves are configured from the same AlertEngineOptions, which is the only way the
    // assertion means anything.
    [Fact]
    public async Task The_engine_cannot_hear_the_topic_the_dispatcher_publishes_to()
    {
        var sut = CreateSut();

        await sut.RaisedAsync([Fired()]);
        await Settled(sut);

        var published = Assert.Single(_publisher.Sent);

        var core = new AlertEngineCore(_options);
        core.SetRules(
            [new AlertRule("loop", "Anything at all", Enabled: true, Filter: "#", Field: null,
                Condition: new ThresholdCondition(ThresholdOp.Gt, -1), Clear: null, For: null,
                Cooldown: null, AlertSeverity.Warn, [new ScreenAction()])],
            T0);

        var outcome = core.OnMessage(
            new MqttMessage(published.Topic, TextOf(published), "text", 0, false, T0), T0);

        Assert.Empty(outcome.Raised);
    }

    // Locked, and read as a copy: the dispatcher publishes from a loop of its own while the test
    // thread reads what it sent.
    private sealed class RecordingPublisher : IMqttPublisher
    {
        private readonly Lock _gate = new();
        private readonly List<PublishRequest> _sent = [];
        private TaskCompletionSource? _stuck;
        private int _held;

        public IReadOnlyList<PublishRequest> Sent
        {
            get { lock (_gate) return [.. _sent]; }
        }

        /// <summary>Set to make the next publish fail the way a dropped link fails.</summary>
        public Func<Exception>? Throw { get; set; }

        /// <summary>Set to make the next publish behave like a half-open socket: no answer, ever.</summary>
        // It watches the token and nothing else, which is exactly what MqttnetPublisher does with
        // it — so a dispatcher that passes CancellationToken.None waits here for ever, and that is
        // the failure the test above is written to catch.
        public bool Hang { get; set; }

        /// <summary>
        /// When set, every publish waits until it is cleared, or until its token calls it off: a
        /// broker slow to take them. What it is handed meanwhile is sent once it is let go.
        /// </summary>
        public bool Stall
        {
            set
            {
                lock (_gate)
                {
                    if (value) _stuck ??= new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                    else
                    {
                        _stuck?.TrySetResult();
                        _stuck = null;
                    }
                }
            }
        }

        /// <summary>How many publishes are waiting on the stalled broker right now.</summary>
        public int Held => Volatile.Read(ref _held);

        public void Clear()
        {
            lock (_gate) _sent.Clear();
        }

        public async Task PublishAsync(PublishRequest request, CancellationToken ct)
        {
            if (Throw is not null) throw Throw();

            if (Hang) await Task.Delay(Timeout.Infinite, ct);

            Task? stuck;
            lock (_gate) stuck = _stuck?.Task;

            if (stuck is not null)
            {
                Interlocked.Increment(ref _held);
                try
                {
                    await stuck.WaitAsync(ct);
                }
                finally
                {
                    Interlocked.Decrement(ref _held);
                }
            }

            lock (_gate) _sent.Add(request);
        }
    }

    private sealed class FakeLifetime : IHostApplicationLifetime
    {
        private readonly CancellationTokenSource _started = new();
        private readonly CancellationTokenSource _stopping = new();
        private readonly CancellationTokenSource _stopped = new();

        public CancellationToken ApplicationStarted => _started.Token;

        public CancellationToken ApplicationStopping => _stopping.Token;

        public CancellationToken ApplicationStopped => _stopped.Token;

        // Synchronous, exactly as the host runs it: the callbacks registered on ApplicationStopping
        // are what hold the shutdown open long enough for the clear to reach the broker.
        public void StopApplication()
        {
            _stopping.Cancel();
            _stopped.Cancel();
        }
    }
}
