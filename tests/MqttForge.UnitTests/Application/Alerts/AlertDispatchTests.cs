using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Time.Testing;
using MqttForge.Application.Alerts;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;

namespace MqttForge.UnitTests.Application.Alerts;

/// <summary>
/// What the engine hands to a dispatcher, and what a broken one is not allowed to cost.
/// </summary>
// A real pump on a real thread with a fake clock, exactly as AlertEngineTests runs one: the whole
// question here is about a call the pump makes on its own thread, and a test that called
// DeliverAsync directly would be testing a method rather than the loop that guards it.
public class AlertDispatchTests
{
    private static readonly DateTimeOffset Start = new(2026, 8, 30, 9, 0, 0, TimeSpan.Zero);

    private static AlertRule Rule(params AlertAction[] actions) =>
        new("hot", "Boiler temperature", Enabled: true, "plant/+/temp", Field: null,
            new ThresholdCondition(ThresholdOp.Gt, 90), Clear: null, For: null, Cooldown: null,
            AlertSeverity.Warn, actions);

    private static AlertAction Hook => new WebhookAction("http://example.invalid/hook", new Dictionary<string, string>());

    private static MqttMessage Message(string topic, string payload) =>
        new(topic, payload, "text", 0, false, Start);

    private sealed class Harness : IAsyncDisposable
    {
        public FakeTimeProvider Time { get; } = new(Start);
        public RecordingAlertNotifier Notifier { get; } = new();
        public RecordingAlertDispatcher Dispatcher { get; } = new();
        public RecordingLogger<AlertEngine> Log { get; } = new();
        public AlertEngine Engine { get; }

        private readonly CancellationTokenSource _cancellation = new();
        private Task? _pump;

        public Harness(AlertRule rule)
        {
            Engine = new AlertEngine(
                new AlertEngineCore(new AlertEngineOptions()),
                new FakeAlertRuleStore { Document = new AlertRuleDocument([rule], Unreadable: false, []) },
                new FakeAlertStateStore(),
                Notifier,
                new FakeConnection { State = ConnectionState.Connected },
                new RecordingSubscriber(),
                Log,
                Time,
                Dispatcher);
        }

        /// <summary>Loads the rule set, then starts the loop on a thread of its own.</summary>
        public async Task StartAsync()
        {
            await Engine.StartAsync(CancellationToken.None);
            _pump = Task.Run(() => Engine.RunAsync(_cancellation.Token));
        }

        public void Post(string topic, string payload) => Engine.Post(new ArrivalCommand(Message(topic, payload)));

        public Task Until(Func<bool> settled, string what) => Eventually.Until(Time, settled, what);

        /// <summary>Moves the clock through whole ticks nothing is expected to happen in.</summary>
        // The proof that an absence is an absence. Asserting an empty list the instant after a
        // message is posted proves only that the pump had not got there yet.
        public async Task TickAsync(int seconds)
        {
            for (var i = 0; i < seconds; i++)
            {
                Time.Advance(TimeSpan.FromSeconds(1));
                await Task.Delay(10);
            }
        }

        public async ValueTask DisposeAsync()
        {
            await _cancellation.CancelAsync();

            // Awaited rather than abandoned, and that is an assertion: a pump that faulted on any
            // turn of any test in this file fails that test here rather than dying in silence.
            if (_pump is not null) await _pump;

            _cancellation.Dispose();
        }
    }

    private static async Task<Harness> StartedAsync(AlertRule rule)
    {
        var harness = new Harness(rule);
        await harness.StartAsync();

        return harness;
    }

    [Fact]
    public async Task An_alert_whose_rule_asks_for_a_webhook_reaches_the_dispatcher()
    {
        await using var harness = await StartedAsync(Rule(new ScreenAction(), Hook));

        harness.Post("plant/boiler/temp", "94.2");

        await harness.Until(() => harness.Dispatcher.Raised.Count == 1, "the alarm reached the dispatcher");

        var dispatched = Assert.Single(harness.Dispatcher.Raised);

        Assert.Equal("plant/boiler/temp", dispatched.Topic);
        Assert.Equal("hot", dispatched.RuleId);

        // The same alert the console was told about, and not a copy made for the wire: the id is
        // what a receiver correlates a resolution against.
        Assert.Equal(Assert.Single(harness.Notifier.Raised).Id, dispatched.Id);
    }

    [Fact]
    public async Task An_alert_whose_rule_asks_for_a_publish_reaches_the_dispatcher()
    {
        await using var harness = await StartedAsync(Rule(new PublishAction(null, 1, false)));

        harness.Post("plant/boiler/temp", "94.2");

        await harness.Until(() => harness.Dispatcher.Raised.Count == 1, "the alarm reached the dispatcher");

        Assert.Equal("plant/boiler/temp", Assert.Single(harness.Dispatcher.Raised).Topic);
    }

    [Fact]
    public async Task A_screen_only_alert_never_reaches_the_dispatcher()
    {
        await using var harness = await StartedAsync(Rule(new ScreenAction(), new SoundAction()));

        harness.Post("plant/boiler/temp", "94.2");

        await harness.Until(() => harness.Notifier.Raised.Count == 1, "the alarm reached the console");
        await harness.TickAsync(3);

        // Nothing about this alert leaves the process, so the dispatcher is not asked. It would
        // have found nothing to do anyway; the point is that a queue with a bounded depth and a
        // shared HttpClient does not get woken for every screen notice on a busy plant.
        Assert.Empty(harness.Dispatcher.Raised);
    }

    [Fact]
    public async Task An_alert_from_a_rule_with_no_actions_at_all_is_not_dispatched()
    {
        await using var harness = await StartedAsync(Rule());

        harness.Post("plant/boiler/temp", "94.2");

        await harness.Until(() => harness.Notifier.Raised.Count == 1, "the alarm reached the console");
        await harness.TickAsync(3);

        // A rule with no channels still rings — it is in the snapshot and the panel draws it —
        // and it has nowhere to be sent.
        Assert.Empty(harness.Dispatcher.Raised);
        Assert.Empty(harness.Dispatcher.Resolved);
        Assert.Single(harness.Engine.Snapshot.Active);
    }

    [Fact]
    public async Task The_resolved_half_reaches_the_dispatcher_too()
    {
        await using var harness = await StartedAsync(Rule(Hook));

        harness.Post("plant/boiler/temp", "94.2");
        await harness.Until(() => harness.Dispatcher.Raised.Count == 1, "the alarm reached the dispatcher");

        harness.Post("plant/boiler/temp", "20.1");

        await harness.Until(() => harness.Dispatcher.Resolved.Count == 1, "the recovery reached the dispatcher");

        var resolved = Assert.Single(harness.Dispatcher.Resolved);

        Assert.NotNull(resolved.ResolvedAt);
        Assert.Equal(Assert.Single(harness.Dispatcher.Raised).Id, resolved.Id);
    }

    [Fact]
    public async Task A_dispatcher_that_throws_leaves_the_notifier_called_and_the_pump_running()
    {
        await using var harness = await StartedAsync(Rule(new ScreenAction(), Hook));
        harness.Dispatcher.Throw = true;

        harness.Post("plant/boiler/temp", "94.2");

        await harness.Until(() => harness.Notifier.Raised.Count == 1, "the console was told anyway");

        // Waited for rather than asserted outright, and the reason is in DeliverAsync: the
        // dispatcher runs AFTER the notifier, because a screen notice must not queue behind a
        // POST. So the moment the console has been told is a moment BEFORE the channel has thrown,
        // and asserting the log here loses a race about one run in three.
        await harness.Until(
            () => harness.Log.Lines.Any(line =>
                line.Level == LogLevel.Error && line.Message.Contains("dispatcher")),
            "the dispatcher's fault reached the log");

        // And the engine is still an engine. A second topic goes past the same rule and rings on
        // its own, which is the assertion that matters: telling somebody is downstream of
        // judging, and a channel that has gone wrong must not stop the next thing going wrong
        // from being noticed.
        harness.Post("plant/pump/temp", "97.0");

        await harness.Until(() => harness.Notifier.Raised.Count == 2, "the next alarm was still judged");
        Assert.Equal(2, harness.Engine.Snapshot.Active.Count);
    }
}
