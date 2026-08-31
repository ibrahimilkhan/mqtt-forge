using System.Diagnostics;
using System.Text;
using Microsoft.Extensions.Hosting;
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

    // The alert's identity is the (rule, topic) pair, so the place it goes has to name the pair.
    // A topic naming the rule alone would send a hundred topics' alarms to one address, and with
    // retain the last writer would be the only one anybody ever sees.
    [Fact]
    public async Task The_default_topic_names_the_pair_and_not_just_the_rule()
    {
        await CreateSut().RaisedAsync([Fired()]);

        Assert.Equal("mqttforge/alerts/r1/plant/boiler/temp",
            Assert.Single(_publisher.Sent).Topic);
    }

    [Fact]
    public async Task A_user_topic_expands_the_topic_placeholder()
    {
        await CreateSut().RaisedAsync([
            Fired(new PublishAction("mqttforge/alerts/boiler/{topic}/state", 0, false))
        ]);

        Assert.Equal("mqttforge/alerts/boiler/plant/boiler/temp/state",
            Assert.Single(_publisher.Sent).Topic);
    }

    // The check that could not be done at save time. A topic that starts inside the prefix and
    // leaves it once the placeholder is filled in is the shape the loop guard exists for, and it
    // only exists after expansion.
    [Fact]
    public async Task A_user_topic_is_checked_against_the_prefix_after_expansion()
    {
        await CreateSut().RaisedAsync([Fired(new PublishAction("{topic}/alarm", 0, false))]);

        Assert.Empty(_publisher.Sent);
    }

    [Fact]
    public async Task A_topic_outside_the_prefix_publishes_nothing_and_says_why()
    {
        var sut = CreateSut();

        await sut.RaisedAsync([Fired(new PublishAction("plant/boiler/alarm", 0, false))]);

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

        await CreateSut().RaisedAsync([alert]);

        Assert.Equal(AlertPayload.For(alert, "raised"), TextOf(Assert.Single(_publisher.Sent)));
    }

    [Fact]
    public async Task A_resolved_alert_carries_the_resolved_body()
    {
        var alert = Fired(@event: "resolved");

        await CreateSut().ResolvedAsync([alert]);

        Assert.Equal(AlertPayload.For(alert, "resolved"), TextOf(Assert.Single(_publisher.Sent)));
    }

    [Fact]
    public async Task The_qos_and_the_retain_flag_come_from_the_action()
    {
        await CreateSut().RaisedAsync([Fired(new PublishAction(null, 2, true))]);

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
        _publisher.Clear();

        await sut.ResolvedAsync([alert]);

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
        _publisher.Clear();

        await sut.ResolvedAsync([Fired(new PublishAction(null, 0, false), "resolved")]);

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

        Assert.Equal(1, sut.Undelivered);
        Assert.Empty(_publisher.Sent);
    }

    [Fact]
    public async Task A_publish_that_never_left_does_not_stop_the_next_alert()
    {
        _publisher.Throw = () => new NotConnectedException("Connect to a broker before publishing.");

        var sut = CreateSut();

        await sut.RaisedAsync([Fired(ruleId: "r1"), Fired(ruleId: "r2")]);

        Assert.Equal(2, sut.Undelivered);
    }

    // The failure a disconnected broker is not: a socket that is open, so nothing throws, and dead,
    // so nothing answers either. MqttnetPublisher hands its token to MQTTnet and waits, and this
    // path is the engine's own pump — so a publish with no deadline on it is every rule in the
    // product stopped for as long as that socket stays half open.
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

        clock.Stop();

        Assert.Equal(1, sut.Undelivered);
        Assert.Empty(_publisher.Sent);
        Assert.Contains(_log.Lines, l => l.Message.Contains("could not be published"));

        // It waited, and then it stopped waiting. The upper bound is loose on purpose — this is
        // an assertion that the call returned at all, not a measurement of the budget.
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

        _publisher.Clear();
        _lifetime.StopApplication();

        Assert.Empty(_publisher.Sent);
    }

    [Fact]
    public async Task An_alert_with_no_publish_action_publishes_nothing()
    {
        await CreateSut().RaisedAsync([Fired(actions: [new ScreenAction(), new SoundAction()])]);

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
        await CreateSut().RaisedAsync([Fired()]);

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

    private sealed class RecordingPublisher : IMqttPublisher
    {
        private readonly List<PublishRequest> _sent = [];

        public IReadOnlyList<PublishRequest> Sent => _sent;

        /// <summary>Set to make the next publish fail the way a dropped link fails.</summary>
        public Func<Exception>? Throw { get; set; }

        /// <summary>Set to make the next publish behave like a half-open socket: no answer, ever.</summary>
        // It watches the token and nothing else, which is exactly what MqttnetPublisher does with
        // it — so a dispatcher that passes CancellationToken.None waits here for ever, and that is
        // the failure the test above is written to catch.
        public bool Hang { get; set; }

        public void Clear() => _sent.Clear();

        public async Task PublishAsync(PublishRequest request, CancellationToken ct)
        {
            if (Throw is not null) throw Throw();

            if (Hang) await Task.Delay(Timeout.Infinite, ct);

            _sent.Add(request);
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
