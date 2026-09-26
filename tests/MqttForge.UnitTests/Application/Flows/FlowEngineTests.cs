using Microsoft.Extensions.Time.Testing;
using MqttForge.Application.Alerts;
using MqttForge.Application.Flows;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Exceptions;
using MqttForge.Domain.Models;
using MqttForge.UnitTests.Application.Alerts;

namespace MqttForge.UnitTests.Application.Flows;

// The thread, and only the thread: what a flow decides is FlowRuntimeTests' business. Every test
// runs the real pump on the thread pool against a fake clock, so "later" is something the test
// says out loud with Advance rather than something it waits for.
//
// IAsyncLifetime and not IAsyncDisposable, because xUnit 2 only ever calls the first: a test class
// that is merely IAsyncDisposable is never disposed, so its pump would run on after the test and a
// pump that had faulted would never be looked at. Stopping it here is also the shutdown test every
// other test gets for free — both loops have to come to an end when the token goes.
public sealed class FlowEngineTests : IAsyncLifetime
{
    // Long enough for a loaded build machine, short enough that a shutdown that hangs is a failed
    // test rather than a run that never ends.
    private static readonly TimeSpan StopPatience = TimeSpan.FromSeconds(10);

    private static readonly DateTimeOffset T0 = new(2026, 9, 26, 9, 0, 0, TimeSpan.Zero);

    private readonly FakeTimeProvider _time = new(T0);
    private readonly FakeFlowStore _store = new();
    private readonly RecordingAlertNotifier _alerts = new();
    private readonly RecordingAlertDispatcher _dispatcher = new();
    private readonly RecordingFlowNotifier _console = new();
    private readonly FakeConnection _connection = new() { State = ConnectionState.Connected };
    private readonly RecordingSubscriber _subscriber = new();
    private readonly RecordingPublisher _publisher = new();
    private readonly CancellationTokenSource _stop = new();
    private Task? _pump;

    private async Task<FlowEngine> RunningAsync(params Flow[] flows) =>
        Run(await StartedAsync(_alerts, _dispatcher, flows));

    private async Task<FlowEngine> RunningAsync(IAlertNotifier alerts, IAlertDispatcher dispatcher, params Flow[] flows) =>
        Run(await StartedAsync(alerts, dispatcher, flows));

    /// <summary>Built and started with no pump yet, so whatever is posted now waits in the queue.</summary>
    private async Task<FlowEngine> StartedAsync(IAlertNotifier alerts, IAlertDispatcher dispatcher, Flow[] flows)
    {
        _store.Flows = flows;

        var engine = new FlowEngine(
            new FlowRuntime(new Random(7)), _store, alerts, _console, _connection, _subscriber, _publisher,
            new AlertEngineOptions(), new RecordingLogger<FlowEngine>(), _time, dispatcher);

        await engine.StartAsync(CancellationToken.None);
        return engine;
    }

    private FlowEngine Run(FlowEngine engine)
    {
        _pump = Task.Run(() => engine.RunAsync(_stop.Token));
        return engine;
    }

    /// <summary>Waits for the pump in real time, with the fake clock held where it is.</summary>
    // Eventually.Until moves the clock a second at a time while it waits. That is right when the
    // point is that something happens at all, and wrong when the point is when it happens: a whole
    // second is a tick, and a tick wakes a pump that slept through what it should have woken for.
    private static async Task ClockStill(Func<bool> settled, string what)
    {
        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(10);

        while (DateTime.UtcNow < deadline)
        {
            if (settled()) return;
            await Task.Delay(5);
        }

        Assert.Fail($"Timed out, with the clock held still, waiting until {what}.");
    }

    public Task InitializeAsync() => Task.CompletedTask;

    public async Task DisposeAsync()
    {
        await _stop.CancelAsync();

        // Awaited rather than abandoned, AlertEngineTests' rule: a pump that faulted on any turn of
        // any test in this file fails that test here rather than dying in silence.
        if (_pump is not null) await _pump.WaitAsync(StopPatience);
        _stop.Dispose();
    }

    private static Flow Watch(string webhook = "") => new FlowBuilder()
        .Node("in", "mqttIn", new { filter = "plant/+/temp" })
        .Node("test", "if", new { field = "$.temp", test = "gt", value = "90" })
        .Node("hot", "alarm", new { name = "Hot", severity = "critical", webhook })
        .Node("fan", "publish", new { topic = "plant/{{topic[1]}}/cmd", payload = "on", qos = 1 })
        .Wire("in", "out", "test", "in")
        .Wire("test", "yes", "hot", "raise")
        .Wire("test", "yes", "fan", "in")
        .Wire("test", "no", "hot", "clear")
        .Build();

    private static MqttMessage Msg(string topic, string payload) => new(topic, payload, "text", 0, false, T0);

    private static long Errors(FlowEngine engine, string node) =>
        engine.Status.Flows.SelectMany(flow => flow.Nodes).FirstOrDefault(one => one.Id == node)?.Errors ?? 0;

    private static long Count(FlowEngine engine, string node) =>
        engine.Status.Flows.SelectMany(flow => flow.Nodes).FirstOrDefault(one => one.Id == node)?.Count ?? 0;

    [Fact]
    public async Task Start_subscribes_the_running_filters_as_the_flows_owner()
    {
        await RunningAsync(Watch());

        var filter = Assert.Single(_subscriber.Filters);
        Assert.Equal("plant/+/temp", filter.Filter);
        Assert.Equal(SubscriptionOwner.Flows, filter.Owners);
    }

    [Fact]
    public async Task A_file_that_cannot_be_read_starts_nothing_and_does_not_stop_the_engine()
    {
        _store.Unreadable = true;

        var engine = await RunningAsync();

        Assert.Empty(engine.Status.Flows);
        Assert.Empty(_subscriber.Batches);
    }

    [Fact]
    public async Task An_arrival_is_run_and_its_publish_goes_out()
    {
        var engine = await RunningAsync(Watch());

        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":95}"));

        await Eventually.Until(_time, () => _publisher.Sent.Count == 1, "the flow to publish");
        Assert.Equal("plant/k1/cmd", _publisher.Sent[0].Topic);
        Assert.Equal(1, _publisher.Sent[0].Qos);
    }

    [Fact]
    public async Task A_flow_alarm_is_told_like_any_alarm_and_dispatched_when_it_asks_to_leave()
    {
        var engine = await RunningAsync(Watch(webhook: "https://hooks.example.com/boiler"));

        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":95}"));

        await Eventually.Until(_time, () => _alerts.Raised.Count == 1 && _dispatcher.Raised.Count == 1,
            "the alarm to be told and dispatched");
        Assert.Equal("flow-f1-hot", Assert.Single(engine.Alarms.Active).RuleId);
    }

    [Fact]
    public async Task An_alarm_that_only_asks_for_the_screen_is_not_dispatched()
    {
        var engine = await RunningAsync(Watch());

        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":95}"));

        await Eventually.Until(_time, () => _alerts.Raised.Count == 1, "the alarm to be told");
        Assert.Empty(_dispatcher.Raised);
    }

    [Fact]
    public async Task A_publish_the_broker_will_not_take_is_counted_on_its_node()
    {
        _publisher.Fault = new NotConnectedException("Connect to a broker before publishing.");
        var engine = await RunningAsync(Watch());

        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":95}"));

        await Eventually.Until(_time, () => Errors(engine, "fan") == 1, "the failure to be counted on the Publish node");
    }

    [Fact]
    public async Task Status_is_pushed_at_start_and_then_at_most_every_quarter_second()
    {
        var engine = await RunningAsync(Watch());
        Assert.Single(_console.Statuses);

        for (var i = 0; i < 200; i++) await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":50}"));
        await Task.Delay(200);

        // The clock has not moved, so however many turns that took, none of them may push again.
        Assert.Single(_console.Statuses);

        _time.Advance(FlowLimits.StatusEvery);
        await Eventually.Until(_time, () => _console.Statuses.Count == 2, "the next push");
        Assert.Equal(200, engine.Status.Flows.Single().Nodes.Single(node => node.Id == "in").Count);
    }

    [Fact]
    public async Task A_deploy_swaps_what_runs_and_what_can_be_injected()
    {
        var engine = await RunningAsync(Watch());
        Assert.False(engine.CanInject("f2", "go"));

        var set = FlowCompiler.CompileAll(
            [Watch(), new FlowBuilder("f2", "Simulator").Node("go", "inject").Build()], FlowBuilder.Prefix);
        engine.Post(new FlowDeploy(set.Compiled, set.Kept));

        await Eventually.Until(_time, () => engine.CanInject("f2", "go"), "the deploy to land");
    }

    [Fact]
    public async Task An_inject_runs_through_the_pump()
    {
        var engine = await RunningAsync(new FlowBuilder()
            .Node("go", "inject", new { topic = "plant/k1/cmd", payload = "on" })
            .Node("send", "publish", new { topic = "{{topic}}", payload = "{{payload}}" })
            .Wire("go", "out", "send", "in")
            .Build());

        Assert.True(engine.CanInject("f1", "go"));
        engine.Post(new FlowInject("f1", "go"));

        await Eventually.Until(_time, () => _publisher.Sent.Count == 1, "the injected message to be published");
    }

    [Fact]
    public async Task A_link_that_comes_back_puts_the_filters_back()
    {
        await RunningAsync(Watch());
        Assert.Single(_subscriber.Batches);

        _connection.State = ConnectionState.Disconnected;
        _subscriber.LinkDropped();
        await Eventually.Until(_time, () => _console.Statuses.Count >= 2, "the pump to see the link go");

        _connection.State = ConnectionState.Connected;

        await Eventually.Until(_time, () => _subscriber.Batches.Count == 2, "the filters to be put back");
    }

    [Fact]
    public async Task A_filter_the_broker_refused_is_said_on_the_node_and_not_asked_for_again()
    {
        _subscriber.Refuse = new MessageRejectedException("Not authorised.", ["plant/+/temp"]);

        var engine = await RunningAsync(Watch());
        await Eventually.Until(_time, () => Errors(engine, "in") == 1, "the refusal to reach the node");

        for (var i = 0; i < 3; i++) _time.Advance(TimeSpan.FromSeconds(1));
        await Task.Delay(50);

        Assert.Single(_subscriber.Batches);
    }

    [Fact]
    public async Task Debug_lines_reach_the_console()
    {
        var engine = await RunningAsync(new FlowBuilder()
            .Node("in", "mqttIn", new { filter = "a/#" })
            .Node("say", "debug")
            .Wire("in", "out", "say", "in")
            .Build());

        await engine.NotifyMessageReceivedAsync(Msg("a/b", "hello"));

        await Eventually.Until(_time, () => _console.Debug.Count == 1, "the line to be pushed");
        Assert.Equal("hello", _console.Debug[0].Text);
    }

    // ---- what wakes the pump ----

    [Fact]
    public async Task A_push_the_throttle_held_back_goes_out_when_its_quarter_second_is_up()
    {
        var engine = await RunningAsync(Watch());

        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":95}"));
        await ClockStill(() => _publisher.Sent.Count == 1, "the arrival to be run");
        Assert.Single(_console.Statuses);

        // A quarter second and not a moment more. The next tick is a whole second away, so a pump
        // that woke only for ticks would sit on this change until then.
        _time.Advance(FlowLimits.StatusEvery);

        await ClockStill(() => _console.Statuses.Count == 2, "the held-back push to go out");
    }

    [Fact]
    public async Task Nothing_is_pushed_while_nothing_moves()
    {
        var engine = await RunningAsync(Watch());

        // Three ticks, a link poll on each, and nothing on any of them the console would draw
        // differently. Every console connected is sent every push, so an idle engine says nothing.
        for (var i = 0; i < 3; i++)
        {
            _time.Advance(FlowEngine.TickInterval);
            await Task.Delay(20);
        }

        // Then one thing that does move, whose push is the proof the pump was turning all along.
        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":95}"));
        await ClockStill(() => _console.Statuses.Count >= 2, "the arrival's push");

        Assert.Equal(2, _console.Statuses.Count);
    }

    [Fact]
    public async Task An_every_runs_when_it_is_due_with_nothing_else_to_wake_the_pump()
    {
        await RunningAsync(new FlowBuilder()
            .Node("tick", "every", new { seconds = 0.3, topic = "plant/sim/ping", payload = "on" })
            .Node("send", "publish", new { topic = "{{topic}}", payload = "{{payload}}" })
            .Wire("tick", "out", "send", "in")
            .Build());

        // Two emissions, neither on a tick. The pump's first turn may catch the first one whenever
        // that turn happens to run, but by the second the pump is known to be waiting, and only the
        // schedule can wake it at 0.6 s.
        _time.Advance(TimeSpan.FromMilliseconds(300));
        await ClockStill(() => _publisher.Sent.Count == 1, "the first emission");

        _time.Advance(TimeSpan.FromMilliseconds(300));
        await ClockStill(() => _publisher.Sent.Count == 2, "the second emission");
    }

    // ---- the publish loop ----

    [Fact]
    public async Task Publishes_leave_one_at_a_time_in_the_order_they_were_asked_for()
    {
        var engine = await RunningAsync(new FlowBuilder()
            .Node("in", "mqttIn", new { filter = "plant/+/list" })
            .Node("each", "forEach", new { field = "$.ids" })
            .Node("send", "publish", new { topic = "plant/{{payload}}/cmd", payload = "on" })
            .Wire("in", "out", "each", "in")
            .Wire("each", "out", "send", "in")
            .Build());

        await engine.NotifyMessageReceivedAsync(Msg("plant/a/list", "{\"ids\":[\"k1\",\"k2\",\"k3\"]}"));
        await engine.NotifyMessageReceivedAsync(Msg("plant/b/list", "{\"ids\":[\"k4\",\"k5\"]}"));

        await Eventually.Until(_time, () => _publisher.Sent.Count == 5, "every publish to go out");
        Assert.Equal(["plant/k1/cmd", "plant/k2/cmd", "plant/k3/cmd", "plant/k4/cmd", "plant/k5/cmd"],
            _publisher.Sent.Select(request => request.Topic));
    }

    [Fact]
    public async Task A_publish_the_broker_never_answers_is_given_up_after_five_seconds_and_the_next_one_goes()
    {
        _publisher.Stall = true;
        var engine = await RunningAsync(Watch());

        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":95}"));
        await ClockStill(() => _publisher.Held == 1, "the publish to be waiting on the broker");

        // The deadline runs on the engine's clock, so this Advance and nothing else ends the wait.
        _publisher.Stall = false;
        _time.Advance(FlowEngine.PublishTimeout);

        const string timedOut = "The broker did not take the publish within 5 seconds.";
        await Eventually.Until(_time, () => _console.Debug.Any(entry => entry.NodeId == "fan" && entry.Text == timedOut),
            "the stalled publish to be given up");
        Assert.Equal(1, Errors(engine, "fan"));

        await engine.NotifyMessageReceivedAsync(Msg("plant/k2/temp", "{\"temp\":95}"));
        await Eventually.Until(_time, () => _publisher.Sent.Count == 1, "the next publish to go out");
        Assert.Equal("plant/k2/cmd", _publisher.Sent[0].Topic);
    }

    [Fact]
    public async Task A_full_outbox_refuses_the_newest_publishes_and_counts_each_on_its_node()
    {
        // One arrival that twenty-one flows answer with fifty publishes each — fifty is what the rate
        // limit lets one flow send at once — so the whole burst lands in a single turn of the pump,
        // behind one publish the broker is sitting on.
        const int flows = 21;
        var burst = Enumerable.Range(1, flows).Select(i => new FlowBuilder($"b{i}", $"Burst {i}")
            .Node("in", "mqttIn", new { filter = "sim/burst" })
            .Node("again", "repeat", new { count = FlowLimits.PublishesPerSecond, seconds = 0 })
            .Node("send", "publish", new { topic = $"sim/{i}/{{{{index}}}}", payload = "x" })
            .Wire("in", "out", "again", "in")
            .Wire("again", "out", "send", "in")
            .Build());
        var first = new FlowBuilder("first", "First")
            .Node("go", "inject", new { topic = "sim/first", payload = "x" })
            .Node("send", "publish", new { topic = "{{topic}}", payload = "{{payload}}" })
            .Wire("go", "out", "send", "in")
            .Build();

        _publisher.Stall = true;
        var engine = await RunningAsync([first, .. burst]);

        engine.Post(new FlowInject("first", "go"));
        await ClockStill(() => _publisher.Held == 1, "the first publish to be sitting with the broker");

        // The push for that, and a quarter second more, so the pump owes the console nothing and
        // pushes in the very turn that runs the burst. Half a second in all: far short of the five
        // that would end the held publish's wait and make room in the outbox.
        _time.Advance(FlowLimits.StatusEvery);
        await ClockStill(() => _console.Statuses.Count == 2, "the push for the first publish");
        _time.Advance(FlowLimits.StatusEvery);

        await engine.NotifyMessageReceivedAsync(Msg("sim/burst", "go"));

        const string full = "Too many publishes were waiting for the broker; this one was dropped.";
        var refused = flows * FlowLimits.PublishesPerSecond - FlowEngine.OutboxCapacity;

        await ClockStill(() => _console.Debug.Count(entry => entry.Text == full) == refused, "every refusal to be said");
        Assert.All(_console.Debug, entry => Assert.Equal("send", entry.NodeId));
        Assert.Equal(refused, engine.Status.Flows.Where(flow => flow.Id != "first")
            .Sum(flow => flow.Nodes.Single(node => node.Id == "send").Errors));
    }

    // ---- subscriptions ----

    [Fact]
    public async Task A_deploy_subscribes_what_arrived_and_unsubscribes_what_went()
    {
        var humidity = new FlowBuilder("f2", "Humidity").Node("in", "mqttIn", new { filter = "plant/+/hum" }).Build();
        var engine = await RunningAsync(Watch(), humidity);

        var doors = new FlowBuilder("f3", "Doors").Node("in", "mqttIn", new { filter = "plant/+/door" }).Build();
        var set = FlowCompiler.CompileAll([humidity, doors], FlowBuilder.Prefix);
        engine.Post(new FlowDeploy(set.Compiled, set.Kept));

        // Both halves, AlertEngineTests' warning: the SUBSCRIBE and the UNSUBSCRIBE go in one turn,
        // one after the other, so a wait that ended at the first could return before the second.
        await Eventually.Until(_time, () => _subscriber.Batches.Count == 2 && _subscriber.Unsubscribed.Count == 1,
            "the new filter to go up and the old one to come down");

        Assert.Equal(["plant/+/door"], _subscriber.Batches[1]);
        Assert.Equal(["plant/+/temp"], _subscriber.Unsubscribed);
        Assert.Equal(["plant/+/door", "plant/+/hum"], _subscriber.Filters.Select(filter => filter.Filter).Order());
    }

    [Fact]
    public async Task A_refused_filter_is_asked_for_again_on_a_new_link()
    {
        _subscriber.Refuse = new MessageRejectedException("Not authorised.", ["plant/+/temp"]);
        await RunningAsync(Watch());

        _subscriber.Refuse = null;
        _connection.State = ConnectionState.Disconnected;
        _subscriber.LinkDropped();
        await Eventually.Until(_time, () => _console.Statuses.Count >= 2, "the pump to see the link go");

        // A broker restarted with a different ACL is the ordinary case: a new link is a new answer.
        _connection.State = ConnectionState.Connected;

        await Eventually.Until(_time, () => _subscriber.Filters.Count == 1, "the filter to be asked for again");
    }

    [Fact]
    public async Task A_refused_filter_is_asked_for_again_after_a_deploy()
    {
        _subscriber.Refuse = new MessageRejectedException("Not authorised.", ["plant/+/temp"]);
        var engine = await RunningAsync(Watch());

        _subscriber.Refuse = null;
        var set = FlowCompiler.CompileAll([Watch()], FlowBuilder.Prefix);
        engine.Post(new FlowDeploy(set.Compiled, set.Kept));

        await Eventually.Until(_time, () => _subscriber.Filters.Count == 1, "the filter to be asked for again");
    }

    // ---- alarms ----

    [Fact]
    public async Task One_event_that_raises_and_clears_an_alarm_is_told_and_sent_raised_first()
    {
        var log = new AlarmCallLog();
        var engine = await RunningAsync(log, log, new FlowBuilder()
            .Node("go", "inject", new { topic = "plant/k1/temp", payload = "[95, 50]" })
            .Node("each", "forEach", new { field = "" })
            .Node("test", "if", new { field = "", test = "gt", value = "90" })
            .Node("hot", "alarm", new { name = "Hot", severity = "critical", webhook = "https://hooks.example.com/boiler" })
            .Wire("go", "out", "each", "in")
            .Wire("each", "out", "test", "in")
            .Wire("test", "yes", "hot", "raise")
            .Wire("test", "no", "hot", "clear")
            .Build());

        engine.Post(new FlowInject("f1", "go"));

        // Raised first, in both channels: a console told of the clear first would drop nothing,
        // then add the raise, and show an alarm that was already over.
        await Eventually.Until(_time, () => log.Calls.Count == 4, "both ends to be told and sent");
        Assert.Equal(["told raised", "told resolved", "sent raised", "sent resolved"], log.Calls);
    }

    [Fact]
    public async Task A_raised_alarm_is_already_in_Alarms_when_the_console_is_told()
    {
        var log = new AlarmCallLog();
        var engine = await RunningAsync(log, log, Watch());
        log.Engine = engine;

        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":95}"));

        // A console that answers alertsRaised by reading GET /api/alerts has to find it there, or
        // the badge lights and goes out again until the next push.
        await Eventually.Until(_time, () => log.UpWhenTold.Count == 1, "the raise to be told");
        Assert.Equal([1], log.UpWhenTold);
    }

    // ---- the debug strip ----

    [Fact]
    public async Task Debug_lines_past_a_hundred_a_push_are_dropped_and_counted()
    {
        var engine = await RunningAsync(new FlowBuilder()
            .Node("go", "inject", new { payload = "hello" })
            .Node("again", "repeat", new { count = 150, seconds = 0 })
            .Node("say", "debug")
            .Wire("go", "out", "again", "in")
            .Wire("again", "out", "say", "in")
            .Build());

        engine.Post(new FlowInject("f1", "go"));

        await Eventually.Until(_time, () => _console.LinesDropped == 50, "the fifty past the ceiling to be counted");
        Assert.Equal(FlowLimits.DebugPerPush, _console.Debug.Count);
    }

    // ---- the queue ----

    [Fact]
    public async Task A_full_queue_drops_the_oldest_and_counts_it()
    {
        var engine = await StartedAsync(_alerts, _dispatcher, [Watch()]);

        // The one arrival that would ring goes in first, and as many again as the queue holds come
        // after it with nothing draining, so the queue makes room by letting the front go.
        await engine.NotifyMessageReceivedAsync(Msg("plant/k0/temp", "{\"temp\":95}"));
        for (var i = 0; i < FlowEngine.QueueCapacity; i++)
            await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":50}"));

        Assert.Equal(1, engine.Dropped);

        Run(engine);
        await Eventually.Until(_time, () => Count(engine, "in") == FlowEngine.QueueCapacity, "the rest to be run");
        Assert.Empty(_alerts.Raised);
    }

    [Fact]
    public async Task Posting_from_many_threads_while_the_pump_runs_loses_nothing()
    {
        // AlertEngineTests' test of the same promise. The runtime is plain dictionaries with no lock
        // in them, and what keeps them whole is that only the pump ever touches them.
        var engine = await RunningAsync(Watch());

        const int writers = 8;
        const int each = 2_000;

        await Task.WhenAll(Enumerable.Range(0, writers).Select(writer => Task.Run(async () =>
        {
            for (var i = 0; i < each; i++)
                await engine.NotifyMessageReceivedAsync(Msg($"plant/line{writer}/temp", "{\"temp\":50}"));
        })));

        // Run or dropped, and nothing in between: the queue is deep enough that nothing drops in
        // practice, but the sum is the honest invariant either way.
        await Eventually.Until(_time, () => Count(engine, "in") + engine.Dropped == writers * each,
            "every arrival to be run or counted as dropped");
    }

    // ---- faults that are not shutdown ----

    [Fact]
    public async Task A_cancellation_that_is_not_shutdown_does_not_stop_the_pump()
    {
        var engine = await RunningAsync(Watch());
        _console.Fault = new OperationCanceledException("The hub gave up on a send.");

        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":95}"));
        await Eventually.Until(_time, () => _console.Failed >= 1, "a push to fail");

        _console.Fault = null;
        await engine.NotifyMessageReceivedAsync(Msg("plant/k2/temp", "{\"temp\":95}"));

        await Eventually.Until(_time, () => _publisher.Sent.Count == 2, "the next arrival to be run");
    }

    [Fact]
    public async Task A_subscribe_the_link_called_off_is_asked_for_again_and_the_flows_run_meanwhile()
    {
        // What MQTTnet 5 can hand back for a SUBSCRIBE that was waiting when its keep-alive gave up
        // on the link: the cancellation of the client's own receive loop, which is not this engine
        // shutting down.
        _subscriber.Refuse = new OperationCanceledException("The link went while the SUBSCRIBE was out.");
        var engine = await RunningAsync(Watch());

        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":95}"));
        await Eventually.Until(_time, () => _publisher.Sent.Count == 1, "the arrival to be run while the SUBSCRIBE keeps failing");

        _subscriber.Refuse = null;

        await Eventually.Until(_time, () => _subscriber.Filters.Count == 1, "the filter to be asked for again");
    }
}
