using System.Runtime.CompilerServices;
using Microsoft.Extensions.Logging;
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
    private readonly RecordingLogger<FlowEngine> _log = new();
    private readonly CancellationTokenSource _stop = new();
    private Task? _pump;

    /// <summary>The engine's clock, when a test needs one the fake cannot be: one that is set back.</summary>
    private TimeProvider? _clock;

    private async Task<FlowEngine> RunningAsync(params Flow[] flows) =>
        Run(await StartedAsync(_alerts, _dispatcher, flows));

    private async Task<FlowEngine> RunningAsync(IAlertNotifier alerts, IAlertDispatcher dispatcher, params Flow[] flows) =>
        Run(await StartedAsync(alerts, dispatcher, flows));

    /// <summary>Built and started with no pump yet, so whatever is posted now waits in the queue.</summary>
    private async Task<FlowEngine> StartedAsync(
        IAlertNotifier alerts, IAlertDispatcher dispatcher, Flow[] flows, IMqttSubscriber? subscriber = null)
    {
        _store.Flows = flows;

        var engine = new FlowEngine(
            new FlowRuntime(new Random(7)), _store, alerts, _console, _connection, subscriber ?? _subscriber,
            _publisher, new AlertEngineOptions(), _log, _clock ?? _time, dispatcher);

        await engine.StartAsync(CancellationToken.None);
        return engine;
    }

    private FlowEngine Run(FlowEngine engine)
    {
        _pump = Task.Run(() => engine.RunAsync(_stop.Token));

        // The push StartAsync made is handed to the console by a loop of the engine's own, which
        // starts with the pump. Every test here counts the console's pushes from that first one.
        var deadline = DateTime.UtcNow + StopPatience;
        while (_console.Answered == 0 && DateTime.UtcNow < deadline) Thread.Sleep(1);

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

    private static MqttMessage Msg(string topic, string payload, DateTimeOffset? receivedAt = null) =>
        new(topic, payload, "text", 0, false, receivedAt ?? T0);

    /// <summary>A live link to a broker, up since <paramref name="connectedAt"/>.</summary>
    private static BrokerLink LinkTo(string host, DateTimeOffset connectedAt) =>
        new(host, 1883, "test", null, false, connectedAt, false, null, null);

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
        // And with the clock held still: the diff belongs to the deploy's own turn, not to the next
        // tick's look at what is missing, which would find the new filter a second later but never
        // take down the old one.
        await ClockStill(() => _subscriber.Batches.Count == 2 && _subscriber.Unsubscribed.Count == 1,
            "the new filter to go up and the old one to come down");

        Assert.Equal(["plant/+/door"], _subscriber.Batches[1]);
        Assert.Equal(["plant/+/temp"], _subscriber.Unsubscribed);
        Assert.Equal(["plant/+/door", "plant/+/hum"], _subscriber.Filters.Select(filter => filter.Filter).Order());
    }

    [Fact]
    public async Task A_filter_refused_after_its_turn_has_pushed_reaches_the_console_a_quarter_second_later()
    {
        await RunningAsync(Watch(), new FlowBuilder("f2", "Simulator")
            .Node("tick", "every", new { seconds = 1, topic = "plant/sim/ping", payload = "on" })
            .Node("say", "debug")
            .Wire("tick", "out", "say", "in")
            .Build());

        // The flows' filter went with nothing to show for it, and the broker now refuses it. The
        // tick that looks for it runs the Every too, and the push for that goes out before the look
        // — so what the look finds has to be pushed on its own. Woken by the clock and not by the
        // queue, the pump turns no more until something else is due.
        _subscriber.LinkDropped();
        _subscriber.Refuse = new MessageRejectedException("Not authorised.", ["plant/+/temp"]);
        _time.Advance(FlowEngine.TickInterval);

        await ClockStill(() => _console.Statuses.Count == 2 && _subscriber.Batches.Count == 2,
            "the tick to push the Every and have the filter refused");
        Assert.Equal(0, InErrors(_console.Statuses[1]));

        // The throttle's quarter second and no more: the next tick is a second away.
        _time.Advance(FlowLimits.StatusEvery);

        await ClockStill(() => _console.Statuses.Count == 3, "the refusal to be pushed");
        Assert.Equal(1, InErrors(_console.Statuses[2]));

        static long InErrors(FlowStatus status) =>
            status.Flows.Single(flow => flow.Id == "f1").Nodes.Single(node => node.Id == "in").Errors;
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

    // What every channel outside the process knows an alarm by is its rule and its topic: a publish
    // goes to a topic named by the two, and a webhook's body carries no alarm id. So two alarms that
    // share them are one alarm out there, and the order they were told in is the only thing that
    // says which of them stands — told a raise and then the end before it, a channel hears the new
    // alarm end with the old one while the book and the console say it is up.

    [Fact]
    public async Task One_event_that_clears_an_alarm_and_raises_it_again_is_told_and_sent_in_that_order()
    {
        var log = new AlarmCallLog();
        var engine = await RunningAsync(log, log, new FlowBuilder()
            .Node("go", "inject", new { topic = "plant/k1/temp", payload = "[95, 50, 95]" })
            .Node("each", "forEach", new { field = "" })
            .Node("test", "if", new { field = "", test = "gt", value = "90" })
            .Node("hot", "alarm", new { name = "Hot", severity = "critical", webhook = "https://hooks.example.com/boiler" })
            .Wire("go", "out", "each", "in")
            .Wire("each", "out", "test", "in")
            .Wire("test", "yes", "hot", "raise")
            .Wire("test", "no", "hot", "clear")
            .Build());

        engine.Post(new FlowInject("f1", "go"));

        await Eventually.Until(_time, () => log.Alarms.Count == 6, "every end of both alarms to be told and sent");
        Assert.Equal(
            ["told raised a", "told resolved a", "told raised b", "sent raised a", "sent resolved a", "sent raised b"],
            log.Alarms);
    }

    [Fact]
    public async Task A_clear_and_a_raise_again_of_one_topic_in_one_turn_are_told_and_sent_in_that_order()
    {
        var log = new AlarmCallLog();
        var engine = await StartedAsync(log, log, [Watch(webhook: "https://hooks.example.com/boiler")]);

        // Hot, cool and hot again, all waiting for the same turn: three events, each its own outcome.
        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":95}"));
        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":50}"));
        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":95}"));
        Run(engine);

        await ClockStill(() => log.Alarms.Count == 6, "every end of both alarms to be told and sent");
        Assert.Equal(
            ["told raised a", "told resolved a", "told raised b", "sent raised a", "sent resolved a", "sent raised b"],
            log.Alarms);
    }

    [Fact]
    public async Task A_move_to_a_broker_carrying_the_same_topic_ends_the_old_alarm_before_it_raises_the_new_one()
    {
        var log = new AlarmCallLog();
        _connection.At("broker-a.plant.local", 1883);
        var engine = await StartedAsync(log, log, [Watch(webhook: "https://hooks.example.com/boiler")]);

        // Broker B carries the plant A did — a cluster, a bridge, a failover pair — so its first
        // message raises an alarm on the rule and topic of the one the move ends. A pump held up for
        // the whole of the move, so A's last message, the move and B's first are all one turn.
        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":95}"));
        _connection.Link = LinkTo("broker-b.plant.local", connectedAt: T0.AddSeconds(1));
        _subscriber.LinkDropped();
        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":95}", receivedAt: T0.AddSeconds(2)));
        Run(engine);

        await ClockStill(() => log.Alarms.Count == 6, "every end of both alarms to be told and sent");
        Assert.Equal(
            ["told raised a", "told resolved a", "told raised b", "sent raised a", "sent resolved a", "sent raised b"],
            log.Alarms);
        Assert.Equal(FlowAlarmBook.ConnectionEnded, Assert.Single(engine.Alarms.History).ResolvedBy);
        Assert.Single(engine.Alarms.Active);
    }

    [Fact]
    public async Task A_raised_alarm_is_already_in_Alarms_when_the_console_is_told()
    {
        var engine = await RunningAsync(Watch());
        _console.Engine = engine;

        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":95}"));

        // A console that answers alertsRaised by reading GET /api/alerts has to find it there, or
        // the badge lights and goes out again until the next push.
        await Eventually.Until(_time, () => _console.UpWhenTold.Count == 1, "the raise to be told");
        Assert.Equal([1], _console.UpWhenTold);
    }

    // The console knows an alarm by its id, so for it the order within one alarm is what counts: an
    // end told before its raise would leave the raise standing on the badge for good.
    [Fact]
    public async Task One_event_that_clears_an_alarm_and_raises_it_again_is_told_to_the_console_in_that_order()
    {
        var engine = await RunningAsync(new FlowBuilder()
            .Node("go", "inject", new { topic = "plant/k1/temp", payload = "[95, 50, 95]" })
            .Node("each", "forEach", new { field = "" })
            .Node("test", "if", new { field = "", test = "gt", value = "90" })
            .Node("hot", "alarm", new { name = "Hot", severity = "critical" })
            .Wire("go", "out", "each", "in")
            .Wire("each", "out", "test", "in")
            .Wire("test", "yes", "hot", "raise")
            .Wire("test", "no", "hot", "clear")
            .Build());

        engine.Post(new FlowInject("f1", "go"));

        await Eventually.Until(_time, () => _console.Alarms.Count == 3, "both alarms to be told to the console");
        Assert.Equal(["raised a", "resolved a", "raised b"], _console.Alarms);
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

    // ---- deploys ----

    private static FlowDeploy Deployment(params Flow[] flows)
    {
        var set = FlowCompiler.CompileAll(flows, FlowBuilder.Prefix);
        return new FlowDeploy(set.Compiled, set.Kept);
    }

    // A deploy is the whole of what should run, and a full queue lets its oldest entry go. Held up
    // long enough, the pump lost one: the file said one thing and the engine ran another until the
    // next deploy or the next restart.
    [Fact]
    public async Task A_deploy_is_never_lost_to_a_full_queue()
    {
        var engine = await StartedAsync(_alerts, _dispatcher, []);

        engine.Post(Deployment(Watch()));
        for (var i = 0; i < FlowEngine.QueueCapacity; i++)
            await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":50}"));
        Run(engine);

        // Run in its place, ahead of every arrival posted after it, and nothing counted as lost.
        await Eventually.Until(_time, () => Count(engine, "in") == FlowEngine.QueueCapacity,
            "every arrival to be judged by the deployed flow");
        Assert.Equal(0, engine.Dropped);
    }

    [Fact]
    public async Task An_arrival_posted_before_a_deploy_is_judged_by_the_flows_running_then()
    {
        var engine = await StartedAsync(_alerts, _dispatcher, [Watch()]);

        // Hot, a deploy that takes the flow away, and hot again, all waiting for one turn.
        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":95}"));
        engine.Post(Deployment());
        await engine.NotifyMessageReceivedAsync(Msg("plant/k2/temp", "{\"temp\":95}"));
        Run(engine);

        await ClockStill(() => _alerts.Resolved.Count == 1, "the first arrival's alarm to end with its flow");
        Assert.Equal("plant/k1/temp", Assert.Single(_alerts.Raised).Topic);
        Assert.Equal(FlowAlarmBook.FlowRemoved, _alerts.Resolved[0].ResolvedBy);
        Assert.Empty(engine.Alarms.Active);
    }

    // Replaced in its slot, a deploy is one no flow will ever run. A pump held up — a broker slow with
    // a SUBSCRIBE, say — must not hold on to every one handed over meanwhile, each a compiled set of up
    // to fifty flows, until it reads their places in the queue.
    [Fact]
    public async Task A_deploy_replaced_before_the_pump_reached_it_is_held_by_nothing()
    {
        var engine = await StartedAsync(_alerts, _dispatcher, []);

        var (replaced, answer) = HandOver(engine, new FlowBuilder("f1").Node("go", "inject").Build());
        engine.Post(Deployment(new FlowBuilder("f2", "Second").Node("go", "inject").Build()));

        GC.Collect();
        GC.WaitForPendingFinalizers();
        GC.Collect();

        Assert.False(replaced.IsAlive, "the replaced deploy is still held");
        Assert.False(answer.IsCompleted);
    }

    /// <summary>Hands a deploy of <paramref name="flow"/> over as FlowService does, and keeps only a weak hold on it.</summary>
    // Made in a method of its own, so no local of the test's keeps the deploy alive in a debug build.
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static (WeakReference Deploy, Task<bool> Answer) HandOver(FlowEngine engine, Flow flow)
    {
        var deploy = Deployment(flow);
        return (new WeakReference(deploy), engine.DeployAsync(deploy, CancellationToken.None));
    }

    // A deploy is the whole of what should run, so of two the pump has not reached only the newer is
    // worth running — in the older one's place, and answering both.
    [Fact]
    public async Task Deploys_the_pump_has_not_reached_are_run_as_the_newest_and_all_are_answered()
    {
        var engine = await StartedAsync(_alerts, _dispatcher, []);

        var first = engine.DeployAsync(Deployment(new FlowBuilder("f1").Node("go", "inject").Build()), CancellationToken.None);
        var second = engine.DeployAsync(Deployment(new FlowBuilder("f2", "Second").Node("go", "inject").Build()), CancellationToken.None);
        Assert.False(first.IsCompleted);

        Run(engine);

        Assert.True(await first.WaitAsync(StopPatience));
        Assert.True(await second.WaitAsync(StopPatience));
        Assert.False(engine.CanInject("f1", "go"));
        Assert.True(engine.CanInject("f2", "go"));
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
    public async Task A_push_the_hub_gives_up_on_is_contained_in_the_push()
    {
        var engine = await RunningAsync(Watch());
        _console.Fault = new OperationCanceledException("The hub gave up on a send.");

        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":95}"));
        await Eventually.Until(_time, () => _console.Failed >= 1, "a push to fail");

        _console.Fault = null;
        await engine.NotifyMessageReceivedAsync(Msg("plant/k2/temp", "{\"temp\":95}"));

        await Eventually.Until(_time, () => _publisher.Sent.Count == 2, "the next arrival to be run");

        // Said as the push's own failure. The turn's catch would keep the pump going too, but it
        // would take the rest of the turn with it — the look at the filters that comes after.
        Assert.Contains(_log.Lines, line => line.Message.StartsWith("Could not tell the console"));
        Assert.DoesNotContain(_log.Lines, line => line.Message.StartsWith("A turn of the flow engine failed"));
    }

    // ---- a console that is slow to read ----

    /// <summary>A flow that answers every reading with a publish and raises nothing, so all the console is sent is pushes.</summary>
    private static Flow Relay() => new FlowBuilder()
        .Node("in", "mqttIn", new { filter = "plant/+/temp" })
        .Node("fan", "publish", new { topic = "plant/{{topic[1]}}/cmd", payload = "on", qos = 1 })
        .Wire("in", "out", "fan", "in")
        .Build();

    // A console that stops reading holds a hub send for as long as its connection lasts — up to the
    // client timeout — and every flow in the product would be waiting on it with the pump.
    [Fact]
    public async Task A_console_that_stops_reading_holds_up_no_flow()
    {
        var engine = await RunningAsync(Relay());
        _console.Stall = true;

        // A change, and the quarter second after which it is pushed — to a console that never takes it.
        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":95}"));
        await ClockStill(() => _publisher.Sent.Count == 1, "the first arrival to be run");
        _time.Advance(FlowLimits.StatusEvery);
        await ClockStill(() => _console.Held == 1, "the push to be stuck with the console");

        await engine.NotifyMessageReceivedAsync(Msg("plant/k2/temp", "{\"temp\":95}"));

        await ClockStill(() => _publisher.Sent.Count == 2, "the next arrival to be judged and its publish sent, with the push still stuck");
    }

    [Fact]
    public async Task A_console_that_was_stuck_is_sent_the_newest_status_and_none_it_missed()
    {
        var engine = await RunningAsync(Relay());
        _console.Stall = true;

        // Three changes, a push a quarter second after each. The first push sticks; the two after it
        // are made while it waits, and only the newest of them is still worth sending.
        for (var i = 1; i <= 3; i++)
        {
            await engine.NotifyMessageReceivedAsync(Msg($"plant/k{i}/temp", "{\"temp\":95}"));
            await ClockStill(() => _publisher.Sent.Count == i, $"arrival {i} to be run");
            _time.Advance(FlowLimits.StatusEvery);
            await ClockStill(() => Count(engine, "in") == i, $"push {i} to be made");

            // In the console's hands before the next is made. Made first, push 2 could take push 1's
            // place in the slot before the loop had taken it, and the console be sent [0, 2, 3].
            if (i == 1) await ClockStill(() => _console.Held == 1, "push 1 to be stuck with the console");
        }

        _console.Stall = false;

        await ClockStill(() => _console.Statuses.Count == 3, "the stuck push and the newest to be taken");
        Assert.Equal([0, 1, 3], _console.Statuses.Select(status => status.Flows.Single().Nodes.Single(node => node.Id == "in").Count));
    }

    [Fact]
    public async Task A_push_stuck_with_a_console_is_called_off_when_the_engine_stops()
    {
        var engine = await RunningAsync(Relay());
        _console.Stall = true;

        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":95}"));
        await ClockStill(() => _publisher.Sent.Count == 1, "the arrival to be run");
        _time.Advance(FlowLimits.StatusEvery);
        await ClockStill(() => _console.Held == 1, "the push to be stuck with the console");

        await _stop.CancelAsync();

        await _pump!.WaitAsync(StopPatience);
        Assert.Equal(0, _console.Held);
    }

    // An alarm is told to the console as a rule's is, through the same hub, and SignalR writes one
    // message at a time to a connection: an alarm frame to a console that has stopped reading waits
    // behind whatever is stuck there, and a pump that waited on it waited as long.
    [Fact]
    public async Task An_alarm_stuck_with_a_console_holds_up_no_flow_and_the_order_holds_once_it_is_let_go()
    {
        var engine = await RunningAsync(Watch());
        _console.Stall = true;

        // The first boiler rings, and its frame sticks with the console.
        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":95}"));
        await ClockStill(() => _console.Held == 1, "the alarm's frame to be stuck with the console");

        // A second boiler rings, and the first cools and rings again.
        await engine.NotifyMessageReceivedAsync(Msg("plant/k2/temp", "{\"temp\":95}"));
        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":50}"));
        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":95}"));

        await ClockStill(() => _publisher.Sent.Count == 3 && _alerts.Raised.Count == 3 && _alerts.Resolved.Count == 1,
            "every arrival to be judged, published and written to the log, with the frame still stuck");
        Assert.Equal(1, _console.Held);

        _console.Stall = false;

        await ClockStill(() => _console.Alarms.Count == 4, "every alarm to reach the console");
        Assert.Equal(["raised a", "raised b", "resolved a", "raised c"], _console.Alarms);
    }

    // The console reads what an Alarm node holds up from the status, and the badge from the alarms:
    // a status that counts an alarm the console has not been told of lights the node and not the rail.
    [Fact]
    public async Task An_alarm_is_told_to_the_console_before_the_status_that_counts_it()
    {
        var engine = await RunningAsync(Watch());
        _console.Stall = true;

        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":95}"));
        await ClockStill(() => _console.Held == 1, "the first alarm's frame to be stuck with the console");

        // A push that counts the first alarm, a second alarm, and a push that counts both — made while
        // the console holds the first frame, so all three wait for it together.
        _time.Advance(FlowLimits.StatusEvery);
        await ClockStill(() => engine.Status.Flows.Single().Nodes.Single(node => node.Id == "hot").Standing.Count == 1,
            "the push counting the first alarm to be made");
        await engine.NotifyMessageReceivedAsync(Msg("plant/k2/temp", "{\"temp\":95}"));
        await ClockStill(() => _publisher.Sent.Count == 2, "the second alarm to be raised");
        _time.Advance(FlowLimits.StatusEvery);
        await ClockStill(() => engine.Status.Flows.Single().Nodes.Single(node => node.Id == "hot").Standing.Count == 2,
            "the push counting both to be made");

        _console.Stall = false;

        await ClockStill(() => _console.Told.Count == 4, "the frames and the newest push to be taken");
        Assert.Equal(["status 0", "raised a", "raised b", "status 2"], _console.Told);
    }

    [Fact]
    public async Task An_alarm_stuck_with_a_console_is_called_off_when_the_engine_stops()
    {
        var engine = await RunningAsync(Watch());
        _console.Stall = true;

        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":95}"));
        await ClockStill(() => _console.Held == 1, "the alarm's frame to be stuck with the console");

        await _stop.CancelAsync();

        await _pump!.WaitAsync(StopPatience);
        Assert.Equal(0, _console.Held);
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

    // What the subscriber says of a SUBSCRIBE the broker never answered: not a refusal, so no node is
    // marked, and the filter is asked for again.
    [Fact]
    public async Task A_subscribe_the_broker_did_not_answer_marks_no_node_and_is_asked_for_again()
    {
        _subscriber.Refuse = new BrokerDidNotAnswerException("The broker did not answer the SUBSCRIBE for 'plant/+/temp' within 10 seconds.");
        var engine = await RunningAsync(Watch());
        _subscriber.Refuse = null;

        await Eventually.Until(_time, () => _subscriber.Filters.Count == 1, "the filter to be asked for again");
        Assert.Equal(0, Errors(engine, "in"));
    }

    // AlertEngine's pause, for its reason: each attempt at a broker that keeps the link and does not
    // answer holds the pump for the subscriber's whole deadline, and one a turn left the pump a turn
    // per deadline. The flows run meanwhile, and the filter is asked for again once the pause is over.
    //
    // The last second is moved on only once the pump is waiting for it, the every test's arrangement:
    // a turn that has read the clock and not yet made its delay makes it from the moved clock, a
    // second late, and with the clock then held still the end of the pause never came. The arrival is
    // run early in the pause, a second in, where it is told to the console at once rather than a
    // quarter of a second after the start's: from there on every wait ends on a whole second, and at
    // the last one before the end the pump has nothing but its tick to do.
    [Fact]
    public async Task A_subscribe_the_broker_did_not_answer_is_asked_again_after_a_pause_and_not_on_the_next_turn()
    {
        var clock = new WatchedClock(_time);
        _clock = clock;
        _subscriber.Refuse = new BrokerDidNotAnswerException("The broker did not answer the SUBSCRIBE for 'plant/+/temp' within 10 seconds.");
        var engine = await RunningAsync(Watch());
        _subscriber.Refuse = null;

        await ClockStill(() => clock.Waits(T0.AddSeconds(1)), "the pump to wait for its first tick");
        _time.Advance(FlowEngine.TickInterval);

        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":95}"));
        await ClockStill(() => _publisher.Sent.Count == 1, "the arrival to be run during the pause");

        for (var second = 2; second < AlertEngine.NoAnswerPause.TotalSeconds; second++)
        {
            _time.Advance(FlowEngine.TickInterval);
            await Task.Delay(10);
        }

        var over = T0 + AlertEngine.NoAnswerPause;
        await ClockStill(() => clock.Waits(over), "the pump to wait for the end of the pause");
        Assert.Single(_subscriber.Batches);

        _time.Advance(FlowEngine.TickInterval);
        await ClockStill(() => _subscriber.Filters.Count == 1, "the filter to be asked for again once the pause is over");
        Assert.Equal(2, _subscriber.Batches.Count);
    }

    // A pause is about the broker that did not answer. A new link is a new answer, asked for at once.
    [Fact]
    public async Task A_new_link_asks_for_the_flows_filters_at_once_whatever_pause_the_last_one_left()
    {
        _subscriber.Refuse = new BrokerDidNotAnswerException("The broker did not answer the SUBSCRIBE for 'plant/+/temp' within 10 seconds.");
        var engine = await RunningAsync(Watch());
        _subscriber.Refuse = null;

        // An alarm on the first link, which the link going ends; then a turn with the link back. The
        // clock is held still at the start all along, well inside the pause the first link left.
        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":95}"));
        await ClockStill(() => _alerts.Raised.Count == 1, "an alarm to stand on the first link");

        _connection.State = ConnectionState.Disconnected;
        _subscriber.LinkDropped();
        await engine.NotifyMessageReceivedAsync(Msg("office/door", "open"));
        await ClockStill(() => _alerts.Resolved.Count == 1, "the pump to see the link go");

        _connection.State = ConnectionState.Connected;
        await engine.NotifyMessageReceivedAsync(Msg("office/door", "shut"));

        await ClockStill(() => _subscriber.Filters.Count == 1, "the flows' filters to be asked for on the new link");
    }

    // AlertEngine's backoff, for its reason: a broker that goes on leaving the SUBSCRIBE unanswered is
    // asked five seconds after the first attempt it left, ten after the second, and so on to a minute.
    [Fact]
    public async Task A_broker_that_goes_on_not_answering_is_asked_again_after_a_longer_pause_each_time()
    {
        _subscriber.Clock = _time;
        _subscriber.Refuse = new BrokerDidNotAnswerException("The broker did not answer the SUBSCRIBE for 'plant/+/temp' within 10 seconds.");
        await RunningAsync(Watch());

        await Eventually.Until(_time, () => _subscriber.Batches.Count == 2, "the filters to be asked for again after the first pause");
        var again = _subscriber.AskedAt[1];
        Assert.True(again - T0 >= AlertEngine.NoAnswerPause);

        // Not answered again, so the next is ten seconds off, not five.
        while (_time.GetUtcNow() < again.AddSeconds(9))
        {
            _time.Advance(FlowEngine.TickInterval);
            await Task.Delay(10);
        }

        Assert.Equal(2, _subscriber.Batches.Count);

        await Eventually.Until(_time, () => _subscriber.Batches.Count == 3, "the filters to be asked for again after the second pause");
        Assert.True(_subscriber.AskedAt[2] - again >= TimeSpan.FromSeconds(10));
    }

    // Yes or no, an answer ends the run: the next silence is paused for five seconds, not twenty.
    [Fact]
    public async Task An_answer_makes_the_next_pause_for_the_flows_the_first_again()
    {
        var silence = new BrokerDidNotAnswerException("The broker did not answer the SUBSCRIBE within 10 seconds.");
        _subscriber.Clock = _time;
        _subscriber.Refuse = silence;
        var engine = await RunningAsync(Watch());

        await Eventually.Until(_time, () => _subscriber.Batches.Count == 2, "the filters to be asked for again after the first pause");
        _subscriber.Refuse = null;
        await Eventually.Until(_time, () => _subscriber.Filters.Count == 1, "the filters to be taken after the second pause");

        // A deploy with a filter of its own, and the broker silent again.
        _subscriber.Refuse = silence;
        engine.Post(Deployment(Watch(), new FlowBuilder("f3", "Doors").Node("in", "mqttIn", new { filter = "plant/+/door" }).Build()));
        await Eventually.Until(_time, () => _subscriber.Batches.Count == 4, "the new filter to be asked for");
        var unanswered = _subscriber.AskedAt[3];

        _subscriber.Refuse = null;
        await Eventually.Until(_time, () => _subscriber.Filters.Count == 2, "the new filter to be asked for again after a pause");
        Assert.InRange(_subscriber.AskedAt[4] - unanswered, AlertEngine.NoAnswerPause, TimeSpan.FromSeconds(9));
    }

    // AlertEngine's, for its reason: a link that went and came back between two turns, which no turn
    // saw down, is a new link all the same, told by its ConnectedAt, and asked for its filters at once.
    [Fact]
    public async Task A_link_that_came_back_between_two_turns_asks_for_the_flows_filters_at_once_whatever_pause_the_last_one_left()
    {
        _connection.Link = new BrokerLink("broker-a.plant.local", 1883, "test", null, false, T0.AddMinutes(-1), false, null, null);
        _subscriber.Refuse = new BrokerDidNotAnswerException("The broker did not answer the SUBSCRIBE for 'plant/+/temp' within 10 seconds.");
        var engine = await RunningAsync(Watch());
        _subscriber.Refuse = null;

        // Dropped and dialled again, to the same broker, with the clock held still at the start, well
        // inside the pause the first link left.
        _subscriber.LinkDropped();
        _connection.Link = new BrokerLink("broker-a.plant.local", 1883, "test", null, false, T0, false, null, null);
        await engine.NotifyMessageReceivedAsync(Msg("office/door", "open"));

        await ClockStill(() => _subscriber.Filters.Count == 1, "the flows' filters to be asked for on the new link");
    }

    // AlertEngine's, for a rule's save: a flow the reader has just deployed is a person waiting to see
    // it run, and its filters are asked for at once, whatever pause a broker that did not answer left.
    [Fact]
    public async Task A_deploy_during_a_pause_has_the_flows_filters_asked_for_at_once()
    {
        _subscriber.Refuse = new BrokerDidNotAnswerException("The broker did not answer the SUBSCRIBE for 'plant/+/temp' within 10 seconds.");
        var engine = await RunningAsync(Watch());
        _subscriber.Refuse = null;

        // Deployed with the clock held still at the start, inside the pause the unanswered SUBSCRIBE left.
        Assert.True(await engine.DeployAsync(Deployment(Watch(), Doors()), CancellationToken.None));

        await ClockStill(() => _subscriber.Filters.Count == 2, "the deployed flows' filters to be asked for");
    }

    // A deploy is no answer, though. One the broker leaves unanswered as well is one more attempt in the
    // run, and the pause after it is the run's next: ten seconds after the second, not five again.
    [Fact]
    public async Task A_deploy_the_broker_leaves_unanswered_too_is_followed_by_the_next_pause_of_the_run()
    {
        _subscriber.Clock = _time;
        _subscriber.Refuse = new BrokerDidNotAnswerException("The broker did not answer the SUBSCRIBE for 'plant/+/temp' within 10 seconds.");
        var engine = await RunningAsync(Watch());

        engine.Post(Deployment(Watch(), Doors()));
        await ClockStill(() => _subscriber.Batches.Count == 2, "the deployed flows' filters to be asked for");
        _subscriber.Refuse = null;

        var second = NoAnswerBackoff.After(2);
        while (_time.GetUtcNow() < T0 + second - FlowEngine.TickInterval)
        {
            _time.Advance(FlowEngine.TickInterval);
            await Task.Delay(10);
        }

        Assert.Equal(2, _subscriber.Batches.Count);

        await Eventually.Until(_time, () => _subscriber.Filters.Count == 2, "the filters to be asked for again after the run's second pause");
        Assert.True(_subscriber.AskedAt[2] - _subscriber.AskedAt[1] >= second);
    }

    private static Flow Doors() => new FlowBuilder("f3", "Doors").Node("in", "mqttIn", new { filter = "plant/+/door" }).Build();

    [Fact]
    public async Task A_cancellation_from_a_fault_nobody_foresaw_does_not_stop_the_pump()
    {
        var subscriber = new SubscriberProbe(_subscriber);
        Run(await StartedAsync(_alerts, _dispatcher, [Watch()], subscriber));

        // Nothing along this path catches a fault of its own, so only the turn's last line of defence
        // stands between it and RunAsync, which would read any cancellation as shutdown.
        subscriber.FiltersFault = new OperationCanceledException("A fault nobody foresaw.");
        _subscriber.LinkDropped();
        await Eventually.Until(_time, () => _log.Lines.Any(line => line.Message.StartsWith("A turn of the flow engine failed")),
            "the fault to be logged");

        subscriber.FiltersFault = null;

        await Eventually.Until(_time, () => _subscriber.Filters.Count == 1, "the pump to carry on and ask for the filter again");
    }

    [Fact]
    public async Task A_cancelled_alarm_channel_is_contained_in_that_channel()
    {
        var cancelled = new OperationCanceledException("The channel gave up.");
        var log = new AlarmCallLog { NotifierFault = cancelled, DispatcherFault = cancelled };
        var engine = await RunningAsync(log, log, Watch(webhook: "https://hooks.example.com/boiler"));

        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":95}"));

        // Neither channel is handed the engine's token, so neither can be telling it to stop: the
        // webhook is still tried after the console's channel gave up, and its own failure is said as
        // that — not as a turn of the pump that failed and took the rest of the turn with it.
        await Eventually.Until(_time, () => _log.Lines.Any(line => line.Message.StartsWith("An alert dispatcher threw")),
            "the dispatcher's own failure to be logged");
        Assert.Equal(["told raised", "sent raised"], log.Calls);
        Assert.DoesNotContain(_log.Lines, line => line.Message.StartsWith("A turn of the flow engine failed"));
    }

    [Fact]
    public async Task A_console_cancelled_at_start_does_not_keep_the_flows_from_starting()
    {
        _console.Fault = new OperationCanceledException("The hub gave up on a send.");
        var engine = await RunningAsync(Watch());
        _console.Fault = null;

        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":95}"));

        await Eventually.Until(_time, () => _publisher.Sent.Count == 1, "the flow to run");
    }

    [Fact]
    public async Task A_command_that_throws_is_skipped_and_the_rest_of_its_turn_still_happens()
    {
        var engine = await StartedAsync(_alerts, _dispatcher, [Watch()]);

        // Three commands for one turn, the middle one poisoned. Nothing the product posts is known
        // to throw, which is the point: the pump must not bet two good arrivals on it.
        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":95}"));
        engine.Post(new FlowArrival(null!));
        await engine.NotifyMessageReceivedAsync(Msg("plant/k2/temp", "{\"temp\":95}"));
        Run(engine);

        await Eventually.Until(_time, () => _publisher.Sent.Count == 2 && _alerts.Raised.Count == 2,
            "both good arrivals to be published and told");
        Assert.Equal(["plant/k1/cmd", "plant/k2/cmd"], _publisher.Sent.Select(request => request.Topic));
        Assert.Contains(_log.Lines, line => line.Level == LogLevel.Error && line.Message.Contains(nameof(FlowArrival)));
    }

    [Fact]
    public async Task A_subscriber_that_throws_when_read_does_not_cost_the_turn_its_alarm_its_publish_or_its_push()
    {
        var subscriber = new SubscriberProbe(_subscriber);
        var engine = await StartedAsync(_alerts, _dispatcher, [Watch()], subscriber);

        // One turn with an arrival to carry out and a tick that looks at the filters, and the look
        // throws — which only the turn's own catch is there to stop.
        subscriber.FiltersFault = new InvalidOperationException("The filter list could not be read.");
        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":95}"));
        _time.Advance(FlowEngine.TickInterval);
        Run(engine);

        await ClockStill(() => _log.Lines.Any(line => line.Message.StartsWith("A turn of the flow engine failed")),
            "the subscriber's fault to reach the turn");
        Assert.Single(_alerts.Raised);
        Assert.Equal(1, Count(engine, "in"));
        await ClockStill(() => _publisher.Sent.Count == 1, "the turn's publish to go out");
    }

    [Fact]
    public async Task A_subscribe_the_broker_does_not_answer_does_not_hold_back_what_its_turn_decided()
    {
        var subscriber = new SubscriberProbe(_subscriber);
        var engine = await StartedAsync(_alerts, _dispatcher, [Watch()], subscriber);

        // The flows' filter gone with nothing to show for it, so the tick's look asks for it again —
        // of a broker that never answers — in the same turn as an arrival that raises an alarm.
        subscriber.Stall = true;
        _subscriber.LinkDropped();
        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":95}"));
        _time.Advance(FlowEngine.TickInterval);
        Run(engine);

        await ClockStill(() => subscriber.Held == 1, "the SUBSCRIBE to be waiting on the broker");
        await ClockStill(() => _alerts.Raised.Count == 1 && _publisher.Sent.Count == 1 && Count(engine, "in") == 1,
            "the turn's alarm, publish and push to go out while it waits");
    }

    // ---- the link, as the pump sees it ----

    [Fact]
    public async Task A_link_that_comes_back_is_known_before_what_came_with_it_is_judged()
    {
        var engine = await RunningAsync(Watch());

        _connection.State = ConnectionState.Disconnected;
        _subscriber.LinkDropped();
        await Eventually.Until(_time, () => _console.Statuses.Count >= 2, "the pump to see the link go");

        // A redial puts the console's own filters back before the flows', so an arrival a flow
        // listens for can reach the queue in the very turn the pump first sees the link again.
        _connection.State = ConnectionState.Connected;
        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":95}"));

        await ClockStill(() => _publisher.Sent.Count == 1, "the arrival's publish to go out");
    }

    [Fact]
    public async Task Filters_that_went_between_two_turns_are_asked_for_again_on_the_next_tick()
    {
        await RunningAsync(Watch());

        // The link went and came back between two turns — or moved to another broker — so no turn
        // saw it down, and the subscriber let the flows' filters go all the same.
        _subscriber.LinkDropped();
        _time.Advance(FlowEngine.TickInterval);

        await ClockStill(() => _subscriber.Filters.Count == 1, "the filter to be asked for again");
        Assert.Equal(2, _subscriber.Batches.Count);
    }

    [Fact]
    public async Task A_move_to_another_broker_that_no_turn_saw_ends_the_alarms_and_asks_again_for_what_was_refused()
    {
        _connection.At("broker-a.plant.local", 1883);
        _subscriber.Refuse = new MessageRejectedException("Not authorised.", ["plant/+/temp"]);
        var engine = await RunningAsync(Watch());
        _subscriber.Refuse = null;

        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":95}"));
        await Eventually.Until(_time, () => _alerts.Raised.Count == 1, "the alarm to stand");

        // MqttnetConnectionManager.ConnectAsync moves a live link to another broker in one call, and
        // State is other than Connected only for the handshake: no turn need ever see it down.
        _connection.At("broker-b.plant.local", 1883);
        _subscriber.LinkDropped();

        // The next turn is enough, with the clock held still: a move is seen when it is seen, and not
        // left for the next tick's look at what is missing — which would skip the refused filter anyway.
        await engine.NotifyMessageReceivedAsync(Msg("plant/k2/temp", "{\"temp\":50}"));

        await ClockStill(() => _alerts.Resolved.Count == 1 && _subscriber.Filters.Count == 1,
            "the alarm to end and the refused filter to be asked for on the new broker");
        Assert.Equal(FlowAlarmBook.ConnectionEnded, _alerts.Resolved[0].ResolvedBy);
    }

    [Fact]
    public async Task An_alarm_raised_by_the_new_brokers_first_arrival_in_the_turn_that_sees_the_move_stays_up()
    {
        _connection.At("broker-a.plant.local", 1883);
        var engine = await RunningAsync(Watch());

        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":95}"));
        await ClockStill(() => _alerts.Raised.Count == 1, "the old broker's alarm to stand");

        // The move, and broker B's first message after it, both waiting for the same turn — the
        // console's own filters go back up on B before the flows see the move.
        _connection.Link = LinkTo("broker-b.plant.local", connectedAt: T0.AddSeconds(1));
        _subscriber.LinkDropped();
        await engine.NotifyMessageReceivedAsync(Msg("plant/k2/temp", "{\"temp\":95}", receivedAt: T0.AddSeconds(2)));

        await ClockStill(() => _alerts.Raised.Count == 2 && _alerts.Resolved.Count >= 1,
            "the move and the new broker's alarm to be told");
        Assert.Equal(["plant/k1/temp"], _alerts.Resolved.Select(alert => alert.Topic));
        Assert.Equal(["plant/k2/temp"], engine.Alarms.Active.Select(alert => alert.Topic));
    }

    [Fact]
    public async Task An_arrival_the_old_broker_sent_before_the_move_is_judged_before_it()
    {
        _connection.At("broker-a.plant.local", 1883);
        var engine = await StartedAsync(_alerts, _dispatcher, [Watch()]);

        // Received from broker A, and still queued when the pump first looks: a pump held up for
        // the whole of the move. Broker B came up a second after it arrived.
        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":95}"));
        _connection.Link = LinkTo("broker-b.plant.local", connectedAt: T0.AddSeconds(1));
        _subscriber.LinkDropped();
        Run(engine);

        // Judged as broker A's, and ended by the move like any other alarm of A's — not left
        // standing on B as a claim about a plant nobody is watching.
        await ClockStill(() => _alerts.Resolved.Count == 1, "the old broker's alarm to end with the move");
        Assert.Equal(FlowAlarmBook.ConnectionEnded, _alerts.Resolved[0].ResolvedBy);
        Assert.Empty(engine.Alarms.Active);
    }

    [Fact]
    public async Task A_move_a_turn_stops_short_of_is_told_by_the_next_turn_where_it_falls()
    {
        _connection.At("broker-a.plant.local", 1883);
        var engine = await StartedAsync(_alerts, _dispatcher, [Watch()]);

        // A turn's worth of broker A's messages, one more of A's that raises an alarm, and B's first,
        // which raises its own: the turn that sees the move stops at its limit short of where it falls.
        for (var i = 0; i < FlowEngine.MaxPerTurn; i++)
            await engine.NotifyMessageReceivedAsync(Msg("plant/k0/temp", "{\"temp\":50}"));
        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":95}"));
        _connection.Link = LinkTo("broker-b.plant.local", connectedAt: T0.AddSeconds(1));
        _subscriber.LinkDropped();
        await engine.NotifyMessageReceivedAsync(Msg("plant/k2/temp", "{\"temp\":95}", receivedAt: T0.AddSeconds(2)));
        Run(engine);

        // Told between A's last message and B's first — not at the end of the turn that ran out,
        // which would have put A's last message on B's side and left its alarm standing there.
        await ClockStill(() => _alerts.Raised.Count == 2, "both brokers' alarms to be told");
        Assert.Equal(["plant/k2/temp"], engine.Alarms.Active.Select(alert => alert.Topic));
        var ended = Assert.Single(engine.Alarms.History);
        Assert.Equal("plant/k1/temp", ended.Topic);
        Assert.Equal(FlowAlarmBook.ConnectionEnded, ended.ResolvedBy);
    }

    [Fact]
    public async Task A_publish_failure_among_the_old_brokers_last_messages_does_not_put_them_after_the_move()
    {
        _connection.At("broker-a.plant.local", 1883);
        var engine = await StartedAsync(_alerts, _dispatcher, [Watch()]);

        // A publish broker A failed — one in flight when A was torn down, or one it never answered —
        // comes back to the queue ahead of a message A had already sent. B came up a second later.
        engine.Post(new FlowPublishFailed("f1", "fan", "The link went before the broker took the publish."));
        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":95}"));
        _connection.Link = LinkTo("broker-b.plant.local", connectedAt: T0.AddSeconds(1));
        _subscriber.LinkDropped();
        Run(engine);

        // A's message is judged as A's, and its alarm ends with the move like any other of A's.
        await ClockStill(() => _alerts.Raised.Count == 1, "broker A's message to be judged");
        Assert.Empty(engine.Alarms.Active);
        Assert.Equal(FlowAlarmBook.ConnectionEnded, Assert.Single(engine.Alarms.History).ResolvedBy);

        await Eventually.Until(_time, () => Errors(engine, "fan") == 1, "the failure to be counted on its node all the same");
    }

    // Each second is moved on only once the pump is waiting for it: a publish is sent from a loop of
    // its own, so seeing it says nothing about whether the pump has made its next delay yet.
    [Fact]
    public async Task An_every_that_comes_due_in_the_turn_that_sees_a_move_is_not_refused_for_want_of_a_link()
    {
        var clock = new WatchedClock(_time);
        _clock = clock;
        _connection.At("broker-a.plant.local", 1883);
        await RunningAsync(new FlowBuilder()
            .Node("tick", "every", new { seconds = 1, topic = "plant/sim/ping", payload = "on" })
            .Node("send", "publish", new { topic = "{{topic}}", payload = "{{payload}}" })
            .Wire("tick", "out", "send", "in")
            .Build());

        await ClockStill(() => clock.Waits(T0.AddSeconds(1)), "the pump to wait for the first emission");
        _time.Advance(TimeSpan.FromSeconds(1));
        await ClockStill(() => _publisher.Sent.Count == 1, "the first emission, on broker A");
        await ClockStill(() => clock.Waits(T0.AddSeconds(2)), "the pump to wait for the next emission");

        // The move, seen by the very turn the next emission wakes. The link was never down, so
        // nothing that comes due in that turn may be told it was.
        _connection.At("broker-b.plant.local", 1883);
        _time.Advance(TimeSpan.FromSeconds(1));

        await ClockStill(() => _publisher.Sent.Count == 2, "the next emission to go out on broker B");
    }

    [Fact]
    public async Task A_link_seen_coming_back_has_the_flows_filters_asked_for_at_once()
    {
        var engine = await RunningAsync(Watch());

        _connection.State = ConnectionState.Disconnected;
        _subscriber.LinkDropped();
        await Eventually.Until(_time, () => _console.Statuses.Count >= 2, "the pump to see the link go");

        // Any turn will do — here a message no flow listens for — and the clock is held still, so the
        // filters go back up in the turn that sees the link, not a second later on the next tick's
        // look at what is missing.
        _connection.State = ConnectionState.Connected;
        await engine.NotifyMessageReceivedAsync(Msg("office/door", "open"));

        await ClockStill(() => _subscriber.Batches.Count == 2, "the flows' filters to go back up");
    }

    [Fact]
    public async Task A_link_whose_broker_is_named_only_after_it_came_up_is_not_taken_for_a_move()
    {
        _connection.At("broker-a.plant.local", 1883);
        var engine = await RunningAsync(Watch());

        _connection.State = ConnectionState.Disconnected;
        _connection.Link = null;
        await Eventually.Until(_time, () => _console.Statuses.Count >= 2, "the pump to see the link go");

        // The manager's own order on a connect: MQTTnet says connected before the manager has
        // recorded where to, so a turn can see a link that is up and a broker nobody has named.
        _connection.State = ConnectionState.Connected;
        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":95}"));
        await Eventually.Until(_time, () => engine.Alarms.Active.Count == 1, "the first alarm to stand");

        _connection.At("broker-b.plant.local", 1883);
        await engine.NotifyMessageReceivedAsync(Msg("plant/k2/temp", "{\"temp\":95}"));

        await Eventually.Until(_time, () => engine.Alarms.Active.Count == 2, "both alarms to stand");
        Assert.Empty(_alerts.Resolved);
    }

    [Fact]
    public async Task The_flows_filters_are_asked_for_at_qos_1()
    {
        var subscriber = new SubscriberProbe(_subscriber);
        await StartedAsync(_alerts, _dispatcher, [Watch()], subscriber);

        // AlertEngine's RuleQos, and its reason: at QoS 0 a broker may drop the very message a flow
        // was drawn to catch, and say nothing.
        Assert.Equal(1, Assert.Single(subscriber.Requests).Qos);
    }

    // ---- a clock that is set back ----

    [Fact]
    public async Task A_clock_set_back_does_not_hold_the_next_push_until_it_catches_up()
    {
        var clock = new SteppingClock(_time);
        _clock = clock;
        var engine = await RunningAsync(Watch());

        // NTP pulling in a clock that ran a day fast: the last push now happened a day from now.
        clock.StepBack(TimeSpan.FromDays(1));

        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":95}"));
        await ClockStill(() => _publisher.Sent.Count == 1, "the arrival to be run");

        // Moved on a second at a time rather than once by a quarter: the pump makes its delay only
        // after it has read the clock, and a single step taken in between fell due a whole wait late
        // with the clock then held still. A push held until the clock caught up would still be a day
        // of these steps away.
        await Eventually.Until(_time, () => _console.Statuses.Count == 2, "the next push, not one a day later");
    }

    [Fact]
    public async Task A_clock_set_back_does_not_stop_the_pump_looking_at_the_link()
    {
        var clock = new SteppingClock(_time);
        _clock = clock;
        await RunningAsync(Watch());

        clock.StepBack(TimeSpan.FromDays(1));
        _subscriber.LinkDropped();

        // A tick a second as before: the tick that was due by the old time must not become one due a
        // day from now, with the link unwatched until then.
        await Eventually.Until(_time, () => _subscriber.Filters.Count == 1, "the filter to be asked for again");
    }

    [Fact]
    public async Task A_clock_set_back_in_the_middle_of_a_turn_does_not_put_the_pump_to_sleep()
    {
        var clock = new SteppingClock(_time);
        _clock = clock;
        var subscriber = new SubscriberProbe(_subscriber);
        Run(await StartedAsync(_alerts, _dispatcher, [Watch()], subscriber));

        // Set back between the turn's reading of the clock and the pump's next one, for its wait — the
        // SUBSCRIBE a turn sends is squarely in between — so no turn is left to put the tick right.
        subscriber.OnSubscribe = () => clock.StepBack(TimeSpan.FromDays(1));
        _subscriber.LinkDropped();
        await Eventually.Until(_time, () => _subscriber.Filters.Count == 1, "the SUBSCRIBE the clock goes back in");

        // Then something only a pump that is still waking up would notice.
        _subscriber.LinkDropped();

        await Eventually.Until(_time, () => _subscriber.Filters.Count == 1, "the filter to be asked for again");
    }
}
