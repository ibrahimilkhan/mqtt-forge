using System.Globalization;
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
        Run(await StartedAsync(_alerts, flows));

    private async Task<FlowEngine> RunningAsync(IAlertNotifier alerts, params Flow[] flows) =>
        Run(await StartedAsync(alerts, flows));

    private async Task<FlowEngine> RunningAsync(IFlowWebhook webhook, params Flow[] flows) =>
        Run(await StartedAsync(_alerts, flows, webhook: webhook));

    /// <summary>Built and started with no pump yet, so whatever is posted now waits in the queue.</summary>
    private async Task<FlowEngine> StartedAsync(
        IAlertNotifier alerts, Flow[] flows, IMqttSubscriber? subscriber = null, IFlowWebhook? webhook = null)
    {
        _store.Flows = flows;

        var engine = new FlowEngine(
            new FlowRuntime(new Random(7)), _store, alerts, _console, _connection, subscriber ?? _subscriber,
            _publisher, new AlertEngineOptions(), _log, _clock ?? _time, webhook);

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

    /// <summary>
    /// The monitor most tests here watch with: forever, read plant/+/temp; over 90, raise Hot and send the
    /// fan on (every hot reading, as the old Watch did); under, clear Hot.
    /// </summary>
    private static Flow Watch() => new ChartBuilder()
        .Node("start", "start").Node("loop", "for", new { forever = true })
        .Node("in", "mqttIn", new { filter = "plant/+/temp" })
        .Node("test", "if", new { field = "$.temp", test = "gt", value = "90" })
        .Node("hot", "alarmRaise", new { name = "Hot", level = "critical" })
        .Node("cool", "alarmClear", new { alarm = "hot" })
        .Node("fan", "publish", new { topic = "plant/{{topic[1]}}/cmd", payload = "on", qos = 1 })
        .Node("end", "end")
        .Then("start", "loop").Wire("loop", "body", "in").Then("in", "test")
        .Wire("test", "yes", "hot").Wire("hot", "raised", "fan").Wire("hot", "up", "fan").Wire("fan", "out", "loop", "next")
        .Wire("test", "no", "cool").Wire("cool", "cleared", "loop", "next").Wire("cool", "none", "loop", "next")
        .Wire("loop", "done", "end")
        .Build();

    /// <summary>Start → the steps given → End: a flow that runs once when it is switched on, as an Inject pressed once did.</summary>
    private static Flow Once(string id, params (string Id, string Type, object? Config)[] steps)
    {
        var chart = new ChartBuilder(id, id).Node("start", "start").Node("end", "end");
        foreach (var (stepId, type, config) in steps) chart.Node(stepId, type, config);
        return chart.Then(["start", .. steps.Select(step => step.Id), "end"]).Build();
    }

    /// <summary>Forever: wait <paramref name="seconds"/>, then the steps given — what an Every was.</summary>
    private static Flow Every(string id, double seconds, params (string Id, string Type, object? Config)[] steps)
    {
        var chart = new ChartBuilder(id, id).Node("start", "start").Node("loop", "for", new { forever = true })
            .Node("tick", "wait", new { seconds = seconds.ToString(CultureInfo.InvariantCulture) })
            .Node("end", "end")
            .Then("start", "loop").Wire("loop", "body", "tick").Wire("loop", "done", "end");

        var previous = "tick";
        foreach (var (stepId, type, config) in steps)
        {
            chart.Node(stepId, type, config).Wire(previous, "out", stepId);
            previous = stepId;
        }

        return chart.Wire(previous, "out", "loop", "next").Build();
    }

    /// <summary>A test run of <paramref name="flow"/>, started through the pump — what pressing an Inject was.</summary>
    private static FlowTestStart Press(Flow flow) =>
        new(FlowCompiler.Compile(flow, ChartBuilder.Prefix).Flow ?? throw new InvalidOperationException("The flow did not compile."));

    private static MqttMessage Msg(string topic, string payload, DateTimeOffset? receivedAt = null) =>
        new(topic, payload, "text", 0, false, receivedAt ?? T0);

    /// <summary>A live link to a broker, up since <paramref name="connectedAt"/>.</summary>
    private static BrokerLink LinkTo(string host, DateTimeOffset connectedAt) =>
        new(host, 1883, "test", null, false, connectedAt, false, null, null);

    private static long Errors(FlowEngine engine, string node) =>
        engine.Status.Runs.SelectMany(run => run.Nodes).FirstOrDefault(one => one.Id == node)?.Errors ?? 0;

    private static string? Note(FlowEngine engine, string node) =>
        engine.Status.Runs.SelectMany(run => run.Nodes).FirstOrDefault(one => one.Id == node)?.Note;

    /// <summary>How many of a Webhook node's posts the channel took, as the engine last pushed it.</summary>
    private static long Posted(FlowEngine engine, string node) =>
        engine.Status.Runs.SelectMany(run => run.Nodes).FirstOrDefault(one => one.Id == node)?.Outs.GetValueOrDefault("posted") ?? 0;

    /// <summary>How many messages an MQTT in node has read, as the engine last pushed it.</summary>
    // What left by its way out, and not its count: a run that read a message comes round to wait at the
    // node again, and has then entered it once more than it has read.
    private static long Read(FlowEngine engine, string node) => Read(engine.Status, node);

    private static long Read(FlowStatus status, string node) =>
        status.Runs.SelectMany(run => run.Nodes).FirstOrDefault(one => one.Id == node)?.Outs.GetValueOrDefault("out") ?? 0;

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

        Assert.Empty(engine.Status.Runs);
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

    // A deploy runs a flow up to its first wait, so a flow that publishes on its way there publishes while
    // the engine starts — and the runtime takes the link to be down until it is told otherwise. Told of
    // the link after the deploy, it refused that publish with a "No broker link" that was not true.
    [Fact]
    public async Task A_flow_switched_on_when_the_engine_starts_publishes_before_its_first_wait_with_the_link_up()
    {
        var engine = await RunningAsync(Once("f1", ("send", "publish", new { topic = "plant/k1/cmd", payload = "on" })));

        await Eventually.Until(_time, () => _publisher.Sent.Count == 1, "the flow's publish to go out");
        Assert.Equal("plant/k1/cmd", Assert.Single(_publisher.Sent).Topic);
        Assert.Equal(0, Errors(engine, "send"));
    }

    // Told as a rule's is — to the log and to the console — and to nothing else. A flow alarm's actions
    // are the screen alone, so no channel that leaves the process has anything to do with it: a flow that
    // wants a webhook after an alarm draws a Webhook node after its raised.
    [Fact]
    public async Task A_flow_alarm_is_told_like_any_alarm_and_never_dispatched()
    {
        var log = new AlarmCallLog();
        var engine = await RunningAsync(log, Watch());

        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":95}"));

        await Eventually.Until(_time, () => log.Calls.Count == 1 && _console.Alarms.Count == 1, "the alarm to be told");
        Assert.Equal(["told raised"], log.Calls);
        Assert.Equal(["raised a"], _console.Alarms);

        var alarm = Assert.Single(engine.Alarms.Active);
        Assert.Equal("flow-f1-hot", alarm.RuleId);
        Assert.IsType<ScreenAction>(Assert.Single(alarm.Actions));
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
        Assert.Equal(200, Read(engine, "in"));
    }

    [Fact]
    public async Task A_deploy_swaps_what_is_switched_on()
    {
        var engine = await RunningAsync(Watch());
        Assert.True(engine.IsActive("f1"));
        Assert.False(engine.IsActive("f2"));

        engine.Post(Deployment(Once("f2")));

        await Eventually.Until(_time, () => engine.IsActive("f2"), "the deploy to land");
        Assert.False(engine.IsActive("f1"));
    }

    [Fact]
    public async Task A_test_started_through_the_pump_runs_and_a_stop_ends_it()
    {
        var engine = await RunningAsync();

        engine.Post(Press(Once("f1",
            ("send", "publish", new { topic = "plant/k1/cmd", payload = "on" }),
            ("ack", "mqttIn", new { filter = "plant/k1/ack" }))));

        // Going, and waiting on its MQTT in once it has published: a test, and nothing switched on.
        await Eventually.Until(_time, () => _publisher.Sent.Count == 1, "the test's publish to go out");
        Assert.True(engine.IsTesting("f1"));
        Assert.False(engine.IsActive("f1"));

        engine.Post(new FlowTestStop("f1"));

        await Eventually.Until(_time, () => !engine.IsTesting("f1"), "the stop to end the test");
    }

    [Fact]
    public async Task A_test_waiting_at_an_mqtt_in_subscribes_its_filter_and_a_stop_gives_it_back()
    {
        var engine = await RunningAsync();

        engine.Post(Press(Once("f1", ("ack", "mqttIn", new { filter = "plant/k1/ack" }))));

        await Eventually.Until(_time, () => _subscriber.Filters.Count == 1, "the test's filter to go up");
        var filter = Assert.Single(_subscriber.Filters);
        Assert.Equal("plant/k1/ack", filter.Filter);
        Assert.Equal(SubscriptionOwner.Flows, filter.Owners);

        engine.Post(new FlowTestStop("f1"));

        await Eventually.Until(_time, () => _subscriber.Filters.Count == 0, "the stopped test's filter to come down");
        Assert.Equal(["plant/k1/ack"], _subscriber.Unsubscribed);
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
        var engine = await RunningAsync(Once("f1", ("in", "mqttIn", new { filter = "a/#" }), ("say", "debug", null)));

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
    public async Task A_wait_that_ends_wakes_the_pump_with_nothing_else_to_wake_it()
    {
        await RunningAsync(Every("f1", 0.3, ("send", "publish", new { topic = "plant/sim/ping", payload = "on" })));

        // Two ends of the wait, neither on a tick. The pump's first turn may catch the first one
        // whenever that turn happens to run, but by the second the pump is known to be waiting, and
        // only the schedule can wake it at 0.6 s.
        _time.Advance(TimeSpan.FromMilliseconds(300));
        await ClockStill(() => _publisher.Sent.Count == 1, "the first wait to end");

        _time.Advance(TimeSpan.FromMilliseconds(300));
        await ClockStill(() => _publisher.Sent.Count == 2, "the second wait to end");
    }

    // ---- the publish loop ----

    [Fact]
    public async Task Publishes_leave_one_at_a_time_in_the_order_they_were_asked_for()
    {
        var engine = await RunningAsync(new ChartBuilder()
            .Node("start", "start").Node("loop", "for", new { forever = true })
            .Node("in", "mqttIn", new { filter = "plant/+/list" })
            .Node("each", "forEach", new { array = "$.ids" })
            .Node("send", "publish", new { topic = "plant/{{payload}}/cmd", payload = "on" })
            .Node("end", "end")
            .Then("start", "loop").Wire("loop", "body", "in").Then("in", "each")
            .Wire("each", "body", "send").Wire("send", "out", "each", "next").Wire("each", "done", "loop", "next")
            .Wire("loop", "done", "end")
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

    /// <summary>A test that publishes to <paramref name="topic"/> and then waits on plant/k1/ack.</summary>
    private static Flow Sending(string topic) =>
        Once("f1", ("send", "publish", new { topic, payload = "on" }), ("ack", "mqttIn", new { filter = "plant/k1/ack" }));

    // Pressed again with the topic put right while the broker still sits on the first test's publish: that
    // publish fails with the second test in the first one's place, and the failure is the first test's.
    // Counted on the second, it would be an error on a node whose publish went out.
    [Fact]
    public async Task A_publish_that_fails_after_its_test_was_replaced_is_not_counted_on_the_test_in_its_place()
    {
        _publisher.Stall = true;
        var engine = await RunningAsync();

        engine.Post(Press(Sending("plant/k1/cdm")));
        await ClockStill(() => _publisher.Held == 1, "the first test's publish to be sitting with the broker");

        engine.Post(Press(Sending("plant/k1/cmd")));
        _publisher.Stall = false;
        _time.Advance(FlowEngine.PublishTimeout);

        // The publish loop gives the first publish up before it sends the second, and an arrival posted
        // after that is applied after the failure: once it has ended the second test, the failure is in.
        await Eventually.Until(_time, () => _publisher.Sent.Count == 1, "the second test's publish to go out");
        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/ack", "ok"));

        await Eventually.Until(_time, () => engine.Status.Runs.Any(run => run.State == FlowRunState.Finished),
            "the second test to finish");
        Assert.Equal("plant/k1/cmd", Assert.Single(_publisher.Sent).Topic);
        Assert.Equal(0, Errors(engine, "send"));
    }

    [Fact]
    public async Task A_full_outbox_refuses_the_newest_publishes_and_counts_each_on_its_node()
    {
        // One arrival that twenty-one flows answer with fifty publishes each — fifty is what the rate
        // limit lets one run send at once — so the whole burst lands in a single turn of the pump,
        // behind one publish the broker is sitting on.
        const int flows = 21;
        var burst = Enumerable.Range(1, flows).Select(i => new ChartBuilder($"b{i}", $"Burst {i}")
            .Node("start", "start").Node("loop", "for", new { forever = true })
            .Node("in", "mqttIn", new { filter = "sim/burst" })
            .Node("again", "for", new { times = FlowLimits.PublishesPerSecond })
            .Node("send", "publish", new { topic = $"sim/{i}/{{{{index}}}}", payload = "x" })
            .Node("end", "end")
            .Then("start", "loop").Wire("loop", "body", "in").Then("in", "again")
            .Wire("again", "body", "send").Wire("send", "out", "again", "next").Wire("again", "done", "loop", "next")
            .Wire("loop", "done", "end")
            .Build());

        _publisher.Stall = true;
        var engine = await RunningAsync([.. burst]);

        engine.Post(Press(Once("first", ("send", "publish", new { topic = "sim/first", payload = "x" }))));
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
        Assert.Equal(refused, engine.Status.Runs.Where(run => run.FlowId != "first")
            .Sum(run => run.Nodes.Single(node => node.Id == "send").Errors));
    }

    // ---- subscriptions ----

    [Fact]
    public async Task A_deploy_subscribes_what_arrived_and_unsubscribes_what_went()
    {
        var humidity = Once("f2", ("in", "mqttIn", new { filter = "plant/+/hum" }));
        var engine = await RunningAsync(Watch(), humidity);

        engine.Post(Deployment(humidity, Doors()));

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
        await RunningAsync(Watch(), Every("f2", 1, ("say", "debug", null)));

        // The flows' filter went with nothing to show for it, and the broker now refuses it. The
        // tick that looks for it ends the Wait too, and the push for that goes out before the look
        // — so what the look finds has to be pushed on its own. Woken by the clock and not by the
        // queue, the pump turns no more until something else is due.
        _subscriber.LinkDropped();
        _subscriber.Refuse = new MessageRejectedException("Not authorised.", ["plant/+/temp"]);
        _time.Advance(FlowEngine.TickInterval);

        await ClockStill(() => _console.Statuses.Count == 2 && _subscriber.Batches.Count == 2,
            "the tick to push the Wait's end and have the filter refused");
        Assert.Equal(0, InErrors(_console.Statuses[1]));

        // The throttle's quarter second and no more: the next tick is a second away.
        _time.Advance(FlowLimits.StatusEvery);

        await ClockStill(() => _console.Statuses.Count == 3, "the refusal to be pushed");
        Assert.Equal(1, InErrors(_console.Statuses[2]));

        static long InErrors(FlowStatus status) =>
            status.Runs.Single(run => run.FlowId == "f1").Nodes.Single(node => node.Id == "in").Errors;
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
        engine.Post(Deployment(Watch()));

        await Eventually.Until(_time, () => _subscriber.Filters.Count == 1, "the filter to be asked for again");
    }

    // ---- alarms ----

    /// <summary>
    /// A For each over <paramref name="readings"/>, a variable's JSON array: over 90 raises Hot, anything
    /// else clears it.
    /// </summary>
    // One run's single turn can still raise and clear: a For each walks every element before anything
    // waits, so every raise and clear of the walk is one call into the runtime, and one outcome to tell.
    private static Flow Readings(string readings) => new ChartBuilder()
        .Var("readings", readings)
        .Node("start", "start").Node("each", "forEach", new { array = "var.readings" })
        .Node("test", "if", new { field = "", test = "gt", value = "90" })
        .Node("hot", "alarmRaise", new { name = "Hot", level = "critical" })
        .Node("cool", "alarmClear", new { alarm = "hot" })
        .Node("end", "end")
        .Then("start", "each").Wire("each", "body", "test")
        .Wire("test", "yes", "hot").Wire("hot", "raised", "each", "next").Wire("hot", "up", "each", "next")
        .Wire("test", "no", "cool").Wire("cool", "cleared", "each", "next").Wire("cool", "none", "each", "next")
        .Wire("each", "done", "end")
        .Build();

    [Fact]
    public async Task One_turn_that_raises_and_clears_an_alarm_is_told_raised_first()
    {
        var log = new AlarmCallLog();
        var engine = await RunningAsync(log);

        engine.Post(Deployment(Readings("[95, 50]")));

        // Raised first, to the log and to the console: a console told of the clear first would drop
        // nothing, then add the raise, and show an alarm that was already over.
        await Eventually.Until(_time, () => log.Calls.Count == 2 && _console.Alarms.Count == 2, "both ends to be told");
        Assert.Equal(["told raised", "told resolved"], log.Calls);
        Assert.Equal(["raised a", "resolved a"], _console.Alarms);
    }

    // The log knows an alarm by its rule and its topic, as every channel outside the process did: a log
    // line names the two and no alarm id. So two alarms that share them are one alarm there, and the
    // order they were told in is the only thing that says which of them stands — told a raise and then
    // the end before it, the log says the new alarm ended with the old one while the book and the
    // console say it is up.

    [Fact]
    public async Task One_turn_that_clears_an_alarm_and_raises_it_again_is_told_in_that_order()
    {
        var log = new AlarmCallLog();
        var engine = await RunningAsync(log);

        engine.Post(Deployment(Readings("[95, 50, 95]")));

        await Eventually.Until(_time, () => log.Alarms.Count == 3, "every end of both alarms to be told");
        Assert.Equal(["told raised a", "told resolved a", "told raised b"], log.Alarms);
    }

    [Fact]
    public async Task A_clear_and_a_raise_again_of_one_topic_in_one_turn_are_told_in_that_order()
    {
        var log = new AlarmCallLog();
        var engine = await StartedAsync(log, [Watch()]);

        // Hot, cool and hot again, all waiting for the same turn: three arrivals, each its own outcome.
        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":95}"));
        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":50}"));
        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":95}"));
        Run(engine);

        await ClockStill(() => log.Alarms.Count == 3, "every end of both alarms to be told");
        Assert.Equal(["told raised a", "told resolved a", "told raised b"], log.Alarms);
    }

    [Fact]
    public async Task A_move_to_a_broker_carrying_the_same_topic_ends_the_old_alarm_before_it_raises_the_new_one()
    {
        var log = new AlarmCallLog();
        _connection.At("broker-a.plant.local", 1883);
        var engine = await StartedAsync(log, [Watch()]);

        // Broker B carries the plant A did — a cluster, a bridge, a failover pair — so its first
        // message raises an alarm on the rule and topic of the one the move ends. A pump held up for
        // the whole of the move, so A's last message, the move and B's first are all one turn.
        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":95}"));
        _connection.Link = LinkTo("broker-b.plant.local", connectedAt: T0.AddSeconds(1));
        _subscriber.LinkDropped();
        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":95}", receivedAt: T0.AddSeconds(2)));
        Run(engine);

        await ClockStill(() => log.Alarms.Count == 3, "every end of both alarms to be told");
        Assert.Equal(["told raised a", "told resolved a", "told raised b"], log.Alarms);
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
    public async Task One_turn_that_clears_an_alarm_and_raises_it_again_is_told_to_the_console_in_that_order()
    {
        var engine = await RunningAsync();

        engine.Post(Deployment(Readings("[95, 50, 95]")));

        await Eventually.Until(_time, () => _console.Alarms.Count == 3, "both alarms to be told to the console");
        Assert.Equal(["raised a", "resolved a", "raised b"], _console.Alarms);
    }

    // ---- tones, notices and webhooks ----

    [Fact]
    public async Task Tones_and_notices_reach_the_console_after_the_alarm_they_follow()
    {
        var flow = new ChartBuilder()
            .Node("start", "start").Node("hot", "alarmRaise", new { name = "Hot", level = "warn" })
            .Node("beep", "sound", new { level = "warn" }).Node("tell", "notify", new { text = "Hot!", level = "warn" })
            .Node("end", "end")
            .Then("start", "hot").Wire("hot", "raised", "beep").Wire("hot", "up", "end").Then("beep", "tell", "end")
            .Build();

        await RunningAsync(flow);

        await Eventually.Until(_time, () => _console.Notices.Count == 1, "the notice to reach the console");
        Assert.Equal(AlertSeverity.Warn, Assert.Single(_console.Sounds).Level);
        Assert.Equal("Hot!", _console.Notices[0].Text);
        Assert.Equal(["raised a", "sounds", "notices"], _console.Told.Where(kind => !kind.StartsWith("status")).Take(3));
    }

    // The log is told of an alarm on the pump, before the alarm is handed to the console's loop, and that
    // loop runs beside the pump. A tone handed to it first would be sent while the log was still being
    // told, and the alarm it follows after it.
    [Fact]
    public async Task A_tone_is_handed_to_the_console_only_after_the_alarm_it_follows()
    {
        var engine = await RunningAsync(new SlowLog(() => _console.Sounds.Count > 0), new ChartBuilder()
            .Node("start", "start").Node("loop", "for", new { forever = true })
            .Node("in", "mqttIn", new { filter = "plant/+/temp" })
            .Node("hot", "alarmRaise", new { name = "Hot", level = "warn" })
            .Node("beep", "sound", new { level = "warn" })
            .Node("end", "end")
            .Then("start", "loop").Wire("loop", "body", "in").Then("in", "hot")
            .Wire("hot", "raised", "beep").Wire("hot", "up", "loop", "next").Wire("beep", "out", "loop", "next")
            .Wire("loop", "done", "end")
            .Build());

        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "95"));

        await Eventually.Until(_time, () => _console.Sounds.Count == 1, "the tone to reach the console");
        Assert.Equal(["raised a", "sounds"], _console.Told.Where(kind => !kind.StartsWith("status")));
    }

    /// <summary>A log slow to take a raise: it holds the pump until <paramref name="done"/> holds, or for half a second.</summary>
    private sealed class SlowLog(Func<bool> done) : IAlertNotifier
    {
        public async Task RaisedAsync(IReadOnlyList<Alert> alerts)
        {
            var deadline = DateTime.UtcNow + TimeSpan.FromMilliseconds(500);
            while (!done() && DateTime.UtcNow < deadline) await Task.Delay(5);
        }

        public Task ResolvedAsync(IReadOnlyList<Alert> alerts) => Task.CompletedTask;

        public Task DroppedAsync(int total) => Task.CompletedTask;
    }

    // Taken, and given up on later: the channel had it, so it was posted, and its failure is counted beside
    // that and does not take it back.
    [Fact]
    public async Task A_webhook_post_goes_to_the_webhook_channel_and_a_post_it_gives_up_on_is_counted_on_its_node()
    {
        var webhook = new RecordingFlowWebhook();
        var engine = await RunningAsync(webhook, Once("f1", ("hook", "webhook", new { url = "https://hooks.example.com/x", body = "{\"a\":1}" })));

        await Eventually.Until(_time, () => webhook.Posts.Count == 1, "the post to reach the channel");
        Assert.Equal("application/json", webhook.Posts[0].ContentType);

        webhook.Fail(0, "The endpoint answered 500.");

        await Eventually.Until(_time, () => Errors(engine, "hook") == 1, "the failure to be counted on the node");
        Assert.Equal(1, Posted(engine, "hook"));
    }

    // Refused at the hand-over, by an engine that has no channel to hand it to: an error on its node, and not
    // a post, since nothing was ever posted.
    [Fact]
    public async Task A_webhook_with_no_channel_is_an_error_on_its_node_and_is_not_counted_as_posted()
    {
        var engine = await RunningAsync(Once("f1", ("hook", "webhook", new { url = "https://hooks.example.com/x" })));

        // Waited for in the strip, which the console is sent after the status that counts the error.
        await Eventually.Until(_time, () => _console.Debug.Any(line => line.NodeId == "hook" && line.Text.Contains("AllowWebhooks")),
            "the refusal to be said in the debug strip");
        Assert.Equal(1, Errors(engine, "hook"));
        Assert.Equal(0, Posted(engine, "hook"));

        // The channel's sentence, word for word: a node says the same thing whichever of the two locks held.
        // Read in the strip, which carries it whole; the note under the node is cut to its eighty characters.
        Assert.Contains(_console.Debug, line => line.NodeId == "hook" && line.Text == IFlowWebhook.TurnedOff);
    }

    [Fact]
    public async Task A_full_webhook_channel_drops_the_post_says_so_on_its_node_and_does_not_count_it_as_posted()
    {
        var webhook = new RecordingFlowWebhook { Full = true };
        var engine = await RunningAsync(webhook, Once("f1", ("hook", "webhook", new { url = "https://hooks.example.com/x" })));

        await Eventually.Until(_time, () => _console.Debug.Any(line => line.NodeId == "hook" && line.Text.StartsWith("Too many webhook posts")),
            "the drop to be said in the debug strip");
        Assert.Equal(1, Errors(engine, "hook"));
        Assert.Equal(0, Posted(engine, "hook"));
        Assert.Empty(webhook.Posts);
    }

    // The turn hands its posts on before it tells the console of the alarms it raised and the tones it
    // chose, and a throw from the channel would end the turn there: the alarm in the book and the console
    // never told. The channel's contract is that it never throws, which is the channel's to keep and not
    // something the turn can lean on, so a post that could not be handed on is a failed step on its node,
    // as a full queue's is, and the rest of the turn goes out as it was.
    [Fact]
    public async Task A_webhook_channel_that_throws_costs_the_turn_nothing_and_is_counted_on_the_node()
    {
        var webhook = new RecordingFlowWebhook { Fault = new InvalidOperationException("the queue is gone") };
        var engine = await RunningAsync(webhook, new ChartBuilder()
            .Node("start", "start").Node("in", "mqttIn", new { filter = "plant/+/temp" })
            .Node("hot", "alarmRaise", new { name = "Hot", level = "warn" })
            .Node("hook", "webhook", new { url = "https://hooks.example.com/x" })
            .Node("beep", "sound", new { level = "warn" })
            .Node("end", "end")
            .Then("start", "in", "hot").Wire("hot", "raised", "hook").Wire("hot", "up", "end").Then("hook", "beep", "end")
            .Build());

        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "95"));

        await Eventually.Until(_time, () => _console.Alarms.Count == 1 && _console.Sounds.Count == 1,
            "the turn's alarm and tone to reach the console");
        await Eventually.Until(_time, () => Errors(engine, "hook") == 1, "the failure to be counted on the node");

        // Said as the channel's own fault, and not as a turn of the pump that failed: the turn went on. And a
        // post the channel threw on was never taken, so it was never posted either.
        Assert.Equal("Webhook failed: the queue is gone", Note(engine, "hook"));
        Assert.Equal(0, Posted(engine, "hook"));
        Assert.Contains(_log.Lines, line => line.Level == LogLevel.Error && line.Message.StartsWith("The webhook channel threw"));
        Assert.DoesNotContain(_log.Lines, line => line.Message.StartsWith("A turn of the flow engine failed"));
    }

    /// <summary>A test that posts to <paramref name="url"/> and then waits on plant/k1/ack.</summary>
    private static Flow Hooking(string url) =>
        Once("f1", ("hook", "webhook", new { url }), ("ack", "mqttIn", new { filter = "plant/k1/ack" }));

    // The channel gives the first test's post up with the second test in its place, and then the second
    // test's own, which is that test's to count. Applied in the order they were said, so once the node
    // carries the second one's reason, the first one has been looked at too.
    [Fact]
    public async Task A_webhook_post_given_up_on_after_its_test_was_replaced_is_not_counted_on_the_test_in_its_place()
    {
        var webhook = new RecordingFlowWebhook();
        var engine = await RunningAsync(webhook);

        engine.Post(Press(Hooking("https://hooks.example.com/typo")));
        await Eventually.Until(_time, () => webhook.Posts.Count == 1, "the first test's post to reach the channel");

        engine.Post(Press(Hooking("https://hooks.example.com/x")));
        await Eventually.Until(_time, () => webhook.Posts.Count == 2, "the second test's post to reach the channel");

        webhook.Fail(0, "The endpoint answered 404.");
        webhook.Fail(1, "The endpoint answered 500.");

        await Eventually.Until(_time, () => Note(engine, "hook") == "The endpoint answered 500.",
            "the second test's own failure to be counted");
        Assert.Equal(1, Errors(engine, "hook"));
    }

    [Fact]
    public async Task A_run_that_ends_gives_its_filters_back()
    {
        var engine = await RunningAsync(Once("f1", ("in", "mqttIn", new { filter = "plant/+/temp" })));
        Assert.Equal("plant/+/temp", Assert.Single(_subscriber.Filters).Filter);

        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "1"));

        await Eventually.Until(_time, () => _subscriber.Filters.Count == 0, "the finished run's filter to be taken down");
    }

    // ---- the debug strip ----

    [Fact]
    public async Task Debug_lines_past_a_hundred_a_push_are_dropped_and_counted()
    {
        // A For of 150 around a Debug, which runs the moment the flow is switched on.
        await RunningAsync(new ChartBuilder()
            .Node("start", "start").Node("again", "for", new { times = 150 }).Node("say", "debug").Node("end", "end")
            .Then("start", "again").Wire("again", "body", "say").Wire("say", "out", "again", "next").Wire("again", "done", "end")
            .Build());

        await Eventually.Until(_time, () => _console.LinesDropped == 50, "the fifty past the ceiling to be counted");
        Assert.Equal(FlowLimits.DebugPerPush, _console.Debug.Count);
    }

    // ---- deploys ----

    private static FlowDeploy Deployment(params Flow[] flows)
    {
        var set = FlowCompiler.CompileAll(flows, ChartBuilder.Prefix);
        return new FlowDeploy(set.Compiled, set.Kept);
    }

    // A deploy is the whole of what should run, and a full queue lets its oldest entry go. Held up
    // long enough, the pump lost one: the file said one thing and the engine ran another until the
    // next deploy or the next restart.
    [Fact]
    public async Task A_deploy_is_never_lost_to_a_full_queue()
    {
        var engine = await StartedAsync(_alerts, []);

        engine.Post(Deployment(Watch()));
        for (var i = 0; i < FlowEngine.QueueCapacity; i++)
            await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":50}"));
        Run(engine);

        // Run in its place, ahead of every arrival posted after it, and nothing counted as lost.
        await Eventually.Until(_time, () => Read(engine, "in") == FlowEngine.QueueCapacity,
            "every arrival to be judged by the deployed flow");
        Assert.Equal(0, engine.Dropped);
    }

    [Fact]
    public async Task An_arrival_posted_before_a_deploy_is_judged_by_the_flows_running_then()
    {
        var engine = await StartedAsync(_alerts, [Watch()]);

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
        var engine = await StartedAsync(_alerts, []);

        var (replaced, answer) = HandOver(engine, Once("f1"));
        engine.Post(Deployment(Once("f2")));

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
        var engine = await StartedAsync(_alerts, []);

        var first = engine.DeployAsync(Deployment(Once("f1")), CancellationToken.None);
        var second = engine.DeployAsync(Deployment(Once("f2")), CancellationToken.None);
        Assert.False(first.IsCompleted);

        Run(engine);

        Assert.True(await first.WaitAsync(StopPatience));
        Assert.True(await second.WaitAsync(StopPatience));
        Assert.False(engine.IsActive("f1"));
        Assert.True(engine.IsActive("f2"));
    }

    // ---- a test's start and its stop ----

    // Somebody pressed Test and was told it would run, and a full queue lets its oldest entry go. Held up
    // long enough, the pump lost the start: a 202 for a test that never ran.
    [Fact]
    public async Task A_test_is_never_lost_to_a_full_queue()
    {
        var engine = await StartedAsync(_alerts, []);

        engine.Post(Press(Watch()));
        for (var i = 0; i < FlowEngine.QueueCapacity; i++)
            await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":50}"));
        Run(engine);

        // Started in its place, ahead of every arrival posted after it, and nothing counted as lost.
        await Eventually.Until(_time, () => Read(engine, "in") == FlowEngine.QueueCapacity,
            "every arrival to be read by the test");
        Assert.True(engine.IsTesting("f1"));
        Assert.Equal(0, engine.Dropped);
    }

    // The stop a delete posts as well: lost, it left the test of a flow that is gone running on.
    [Fact]
    public async Task A_stop_is_never_lost_to_a_full_queue()
    {
        var log = new HeldLog();
        var engine = await RunningAsync(log);

        // A test going, and the pump held up in the middle of a turn by a log slow to take the alarm the
        // test raised — as a SUBSCRIBE that a busy broker is slow to answer would hold it.
        engine.Post(Press(Watch()));
        await Eventually.Until(_time, () => engine.IsTesting("f1"), "the test to be going");
        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":95}"));
        await ClockStill(() => log.Holding, "the pump to be held up telling the alarm");

        engine.Post(new FlowTestStop("f1"));
        for (var i = 0; i < FlowEngine.QueueCapacity; i++)
            await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":50}"));
        log.Go();

        await Eventually.Until(_time, () => !engine.IsTesting("f1"), "the stop to end the test");
        Assert.Equal(0, engine.Dropped);
    }

    /// <summary>A log that takes nothing until it is let go: a pump held up in the middle of a turn.</summary>
    private sealed class HeldLog : IAlertNotifier
    {
        private readonly TaskCompletionSource _go = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int _holding;

        /// <summary>Whether it has been handed anything: the pump is waiting on it until it is let go.</summary>
        public bool Holding => Volatile.Read(ref _holding) > 0;

        public void Go() => _go.TrySetResult();

        public Task RaisedAsync(IReadOnlyList<Alert> alerts) => Hold();

        public Task ResolvedAsync(IReadOnlyList<Alert> alerts) => Hold();

        public Task DroppedAsync(int total) => Task.CompletedTask;

        private Task Hold()
        {
            Interlocked.Increment(ref _holding);
            return _go.Task;
        }
    }

    /// <summary>A test that says it has started, with a publish on test/started, and then waits on plant/k1/ack.</summary>
    private static Flow Announcing() =>
        Once("t1", ("hello", "publish", new { topic = "test/started", payload = "1" }), ("ack", "mqttIn", new { filter = "plant/k1/ack" }));

    // Of a flow's start and stop the pump has not reached, only the newer is worth doing: a stop after a
    // start is that start never made. What it would have published goes out before the active flow's
    // publish handed over after it, so once that one is out, it would be too.
    [Fact]
    public async Task A_stop_handed_over_before_the_pump_started_its_test_means_the_test_never_starts()
    {
        var engine = await StartedAsync(_alerts, [Watch()]);

        engine.Post(Press(Announcing()));
        engine.Post(new FlowTestStop("t1"));
        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":95}"));
        Run(engine);

        await Eventually.Until(_time, () => _publisher.Sent.Any(sent => sent.Topic == "plant/k1/cmd"), "the active flow's publish to go out");
        Assert.DoesNotContain(_publisher.Sent, sent => sent.Topic == "test/started");
        Assert.False(engine.IsTesting("t1"));
    }

    [Fact]
    public async Task A_test_handed_over_after_a_stop_the_pump_has_not_reached_is_started()
    {
        var engine = await StartedAsync(_alerts, []);

        engine.Post(new FlowTestStop("t1"));
        engine.Post(Press(Announcing()));
        Run(engine);

        await Eventually.Until(_time, () => _publisher.Sent.Any(sent => sent.Topic == "test/started"), "the test to start");
        Assert.True(engine.IsTesting("t1"));
    }

    // What FlowService counts against the most tests there can be: the tests going, and the starts the pump has
    // not been to. A stop handed over after a start is that start never made, and a stop alone is no test —
    // a delete of a draft nobody saved posts one, and fifty of those must not leave no room for a test.
    [Fact]
    public async Task A_start_the_pump_has_not_reached_is_counted_with_the_tests_going_and_a_stop_is_not()
    {
        var engine = await StartedAsync(_alerts, []);

        engine.Post(Press(Once("a", ("in", "mqttIn", new { filter = "plant/k1/a" }))));
        engine.Post(Press(Once("b", ("in", "mqttIn", new { filter = "plant/k1/b" }))));
        engine.Post(new FlowTestStop("b"));
        engine.Post(new FlowTestStop("c"));

        Assert.Equal("a", Assert.Single(engine.TestsGoingOrWaiting()));

        // Once the pump has been to it, the test going is the one counted, and still the one.
        Run(engine);
        await Eventually.Until(_time, () => engine.IsTesting("a"), "the test to be going");
        Assert.Equal("a", Assert.Single(engine.TestsGoingOrWaiting()));
    }

    // A test starts where it was handed over in the order of everything posted, as a deploy does: what
    // arrived before it is not its to read, and what arrived after it is.
    [Fact]
    public async Task An_arrival_posted_before_a_test_is_not_read_by_it_and_one_posted_after_it_is()
    {
        var engine = await StartedAsync(_alerts, []);

        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":95}"));
        engine.Post(Press(Watch()));
        await engine.NotifyMessageReceivedAsync(Msg("plant/k2/temp", "{\"temp\":95}"));
        Run(engine);

        await Eventually.Until(_time, () => _publisher.Sent.Count == 1, "the test to judge the arrival after it");
        Assert.Equal("plant/k2/cmd", Assert.Single(_publisher.Sent).Topic);
    }

    // ---- the queue ----

    [Fact]
    public async Task A_full_queue_drops_the_oldest_and_counts_it()
    {
        var engine = await StartedAsync(_alerts, [Watch()]);

        // The one arrival that would ring goes in first, and as many again as the queue holds come
        // after it with nothing draining, so the queue makes room by letting the front go.
        await engine.NotifyMessageReceivedAsync(Msg("plant/k0/temp", "{\"temp\":95}"));
        for (var i = 0; i < FlowEngine.QueueCapacity; i++)
            await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":50}"));

        Assert.Equal(1, engine.Dropped);

        Run(engine);
        await Eventually.Until(_time, () => Read(engine, "in") == FlowEngine.QueueCapacity, "the rest to be run");
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
        await Eventually.Until(_time, () => Read(engine, "in") + engine.Dropped == writers * each,
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
    private static Flow Relay() => new ChartBuilder()
        .Node("start", "start").Node("loop", "for", new { forever = true })
        .Node("in", "mqttIn", new { filter = "plant/+/temp" })
        .Node("fan", "publish", new { topic = "plant/{{topic[1]}}/cmd", payload = "on", qos = 1 })
        .Node("end", "end")
        .Then("start", "loop").Wire("loop", "body", "in").Then("in", "fan").Wire("fan", "out", "loop", "next")
        .Wire("loop", "done", "end")
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
            await ClockStill(() => Read(engine, "in") == i, $"push {i} to be made");

            // In the console's hands before the next is made. Made first, push 2 could take push 1's
            // place in the slot before the loop had taken it, and the console be sent [0, 2, 3].
            if (i == 1) await ClockStill(() => _console.Held == 1, "push 1 to be stuck with the console");
        }

        _console.Stall = false;

        await ClockStill(() => _console.Statuses.Count == 3, "the stuck push and the newest to be taken");
        Assert.Equal([0, 1, 3], _console.Statuses.Select(status => Read(status, "in")));
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

    // The console reads what a Raise alarm node holds up from the status, and the badge from the alarms:
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
        await ClockStill(() => engine.Status.Runs.Single().Nodes.Single(node => node.Id == "hot").Standing.Count == 1,
            "the push counting the first alarm to be made");
        await engine.NotifyMessageReceivedAsync(Msg("plant/k2/temp", "{\"temp\":95}"));
        await ClockStill(() => _publisher.Sent.Count == 2, "the second alarm to be raised");
        _time.Advance(FlowLimits.StatusEvery);
        await ClockStill(() => engine.Status.Runs.Single().Nodes.Single(node => node.Id == "hot").Standing.Count == 2,
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
    // The last second is moved on only once the pump is waiting for it, as the test of a Wait that ends
    // in a move's turn does: a turn that has read the clock and not yet made its delay makes it from the
    // moved clock, a second late, and with the clock then held still the end of the pause never came.
    // The arrival is run early in the pause, a second in, where it is told to the console at once rather
    // than a quarter of a second after the start's: from there on every wait ends on a whole second, and
    // at the last one before the end the pump has nothing but its tick to do.
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
        engine.Post(Deployment(Watch(), Doors()));
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

    /// <summary>A flow that waits on plant/+/door, and so holds that filter while it waits.</summary>
    private static Flow Doors() => Once("f3", ("in", "mqttIn", new { filter = "plant/+/door" }));

    [Fact]
    public async Task A_cancellation_from_a_fault_nobody_foresaw_does_not_stop_the_pump()
    {
        var subscriber = new SubscriberProbe(_subscriber);
        Run(await StartedAsync(_alerts,[Watch()], subscriber));

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
        var log = new AlarmCallLog { NotifierFault = new OperationCanceledException("The channel gave up.") };
        var engine = await RunningAsync(log, Watch());

        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":95}"));

        // The log is not handed the engine's token, so it cannot be telling it to stop: the console is
        // still told after the log gave up, and the log's own failure is said as that — not as a turn of
        // the pump that failed and took the rest of the turn with it.
        await Eventually.Until(_time, () => _console.Alarms.Count == 1, "the console to be told all the same");
        Assert.Equal(["told raised"], log.Calls);
        Assert.Contains(_log.Lines, line => line.Message.StartsWith("An alert notifier threw"));
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
        var engine = await StartedAsync(_alerts,[Watch()]);

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
        var engine = await StartedAsync(_alerts,[Watch()], subscriber);

        // One turn with an arrival to carry out and a tick that looks at the filters, and the look
        // throws — which only the turn's own catch is there to stop.
        subscriber.FiltersFault = new InvalidOperationException("The filter list could not be read.");
        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":95}"));
        _time.Advance(FlowEngine.TickInterval);
        Run(engine);

        await ClockStill(() => _log.Lines.Any(line => line.Message.StartsWith("A turn of the flow engine failed")),
            "the subscriber's fault to reach the turn");
        Assert.Single(_alerts.Raised);
        Assert.Equal(1, Read(engine, "in"));
        await ClockStill(() => _publisher.Sent.Count == 1, "the turn's publish to go out");
    }

    [Fact]
    public async Task A_subscribe_the_broker_does_not_answer_does_not_hold_back_what_its_turn_decided()
    {
        var subscriber = new SubscriberProbe(_subscriber);
        var engine = await StartedAsync(_alerts,[Watch()], subscriber);

        // The flows' filter gone with nothing to show for it, so the tick's look asks for it again —
        // of a broker that never answers — in the same turn as an arrival that raises an alarm.
        subscriber.Stall = true;
        _subscriber.LinkDropped();
        await engine.NotifyMessageReceivedAsync(Msg("plant/k1/temp", "{\"temp\":95}"));
        _time.Advance(FlowEngine.TickInterval);
        Run(engine);

        await ClockStill(() => subscriber.Held == 1, "the SUBSCRIBE to be waiting on the broker");
        await ClockStill(() => _alerts.Raised.Count == 1 && _publisher.Sent.Count == 1 && Read(engine, "in") == 1,
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
        var engine = await StartedAsync(_alerts,[Watch()]);

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
        var engine = await StartedAsync(_alerts,[Watch()]);

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
        var engine = await StartedAsync(_alerts,[Watch()]);

        // A publish broker A failed — one in flight when A was torn down, or one it never answered —
        // comes back to the queue ahead of a message A had already sent. B came up a second later. Its
        // run is the one StartAsync made, the first this runtime has made: serial 1.
        engine.Post(new FlowStepFailed(new FlowRunKey("f1", FlowRunKind.Active), Serial: 1, "fan",
            "The link went before the broker took the publish."));
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
    public async Task A_wait_that_ends_in_the_turn_that_sees_a_move_is_not_refused_for_want_of_a_link()
    {
        var clock = new WatchedClock(_time);
        _clock = clock;
        _connection.At("broker-a.plant.local", 1883);
        await RunningAsync(Every("f1", 1, ("send", "publish", new { topic = "plant/sim/ping", payload = "on" })));

        await ClockStill(() => clock.Waits(T0.AddSeconds(1)), "the pump to wait for the first wait to end");
        _time.Advance(TimeSpan.FromSeconds(1));
        await ClockStill(() => _publisher.Sent.Count == 1, "the first publish, on broker A");
        await ClockStill(() => clock.Waits(T0.AddSeconds(2)), "the pump to wait for the next wait to end");

        // The move, seen by the very turn the next wait's end wakes. The link was never down, so
        // nothing that comes due in that turn may be told it was.
        _connection.At("broker-b.plant.local", 1883);
        _time.Advance(TimeSpan.FromSeconds(1));

        await ClockStill(() => _publisher.Sent.Count == 2, "the next publish to go out on broker B");
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
        await StartedAsync(_alerts,[Watch()], subscriber);

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
        Run(await StartedAsync(_alerts,[Watch()], subscriber));

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
