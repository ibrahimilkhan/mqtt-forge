using System.Text;
using System.Text.Json;
using MqttForge.Application.Flows;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;
using MqttForge.UnitTests.Application.Alerts;

namespace MqttForge.UnitTests.Application.Flows;

public class FlowRuntimeTests
{
    private static readonly DateTimeOffset T0 = new(2026, 9, 26, 9, 0, 0, TimeSpan.Zero);

    private readonly FlowRuntime _runtime = new(new Random(7));

    private static MqttMessage Msg(string topic, string payload, bool replay = false) =>
        new(topic, payload, "text", 0, false, T0, Replay: replay);

    private void Start(params CompiledFlow[] flows)
    {
        _runtime.Deploy(flows, [.. flows.Select(flow => flow.Id)], T0);
        _runtime.OnTick(T0, connected: true);
    }

    private static string Text(FlowPublish publish) => Encoding.UTF8.GetString(publish.Request.Payload);

    private FlowNodeStatus Node(string id, string flowId = "f1") =>
        _runtime.Status().Flows.Single(flow => flow.Id == flowId).Nodes.Single(node => node.Id == id);

    private static FlowBuilder Watch(string id = "f1") => new FlowBuilder(id)
        .Node("in", "mqttIn", new { filter = "plant/+/temp" })
        .Node("test", "if", new { field = "$.temp", test = "gt", value = "90" })
        .Node("hot", "alarm", new { name = "Hot", severity = "critical", reason = "{{topic[1]}} at {{$.temp}}" })
        .Node("fan", "publish", new { topic = "plant/{{topic[1]}}/cmd", payload = "{\"fan\":\"on\"}", qos = 1 })
        .Wire("in", "out", "test", "in")
        .Wire("test", "yes", "hot", "raise")
        .Wire("test", "yes", "fan", "in")
        .Wire("test", "no", "hot", "clear");

    // ---- routing ----

    [Fact]
    public void A_reading_over_the_line_raises_an_alarm_and_publishes()
    {
        Start(Watch().Compile());

        var outcome = _runtime.OnMessage(Msg("plant/k1/temp", "{\"temp\":94.2}"), T0);

        var alarm = Assert.Single(outcome.Raised);
        Assert.Equal("flow-f1-hot", alarm.RuleId);
        Assert.Equal("Boiler watch · Hot", alarm.RuleName);
        Assert.Equal("plant/k1/temp", alarm.Topic);
        Assert.Equal(AlertSeverity.Critical, alarm.Severity);
        Assert.Equal("k1 at 94.2", alarm.Reason);
        Assert.Equal("{\"temp\":94.2}", alarm.Sample);

        var publish = Assert.Single(outcome.Publishes);
        Assert.Equal("plant/k1/cmd", publish.Request.Topic);
        Assert.Equal("{\"fan\":\"on\"}", Text(publish));
        Assert.Equal(1, publish.Request.Qos);
    }

    [Fact]
    public void A_reading_under_the_line_takes_the_no_branch_and_clears_the_alarm()
    {
        Start(Watch().Compile());
        _runtime.OnMessage(Msg("plant/k1/temp", "{\"temp\":94.2}"), T0);

        var outcome = _runtime.OnMessage(Msg("plant/k1/temp", "{\"temp\":71}"), T0.AddSeconds(5));

        var cleared = Assert.Single(outcome.Resolved);
        Assert.Equal("clear", cleared.ResolvedBy);
        Assert.Equal(T0.AddSeconds(5), cleared.ResolvedAt);
        Assert.Empty(outcome.Publishes);
        Assert.Empty(_runtime.Alarms().Active);
    }

    [Fact]
    public void A_second_reading_over_the_line_counts_rather_than_raising_again()
    {
        Start(Watch().Compile());
        _runtime.OnMessage(Msg("plant/k1/temp", "{\"temp\":94.2}"), T0);

        var outcome = _runtime.OnMessage(Msg("plant/k1/temp", "{\"temp\":95}"), T0.AddSeconds(1));

        Assert.Empty(outcome.Raised);
        var alarm = Assert.Single(_runtime.Alarms().Active);
        Assert.Equal(2, alarm.Count);
        Assert.Equal(T0.AddSeconds(1), alarm.LastSeenAt);
    }

    [Fact]
    public void Alarms_belong_to_a_topic()
    {
        Start(Watch().Compile());

        _runtime.OnMessage(Msg("plant/k1/temp", "{\"temp\":94}"), T0);
        _runtime.OnMessage(Msg("plant/k2/temp", "{\"temp\":96}"), T0);
        _runtime.OnMessage(Msg("plant/k1/temp", "{\"temp\":80}"), T0);

        Assert.Equal("plant/k2/temp", Assert.Single(_runtime.Alarms().Active).Topic);
    }

    [Fact]
    public void A_message_without_the_field_goes_down_neither_branch()
    {
        Start(Watch().Compile());
        _runtime.OnMessage(Msg("plant/k1/temp", "{\"temp\":94}"), T0);

        var outcome = _runtime.OnMessage(Msg("plant/k1/temp", "warming up"), T0);

        Assert.True(outcome.IsEmpty);
        Assert.Single(_runtime.Alarms().Active);
        Assert.Equal(1, Node("test").Outs["skipped"]);
    }

    [Fact]
    public void Exists_sends_a_missing_field_to_no()
    {
        Start(new FlowBuilder()
            .Node("in", "mqttIn", new { filter = "a/#" })
            .Node("test", "if", new { field = "$.fault", test = "exists" })
            .Node("say", "debug")
            .Wire("in", "out", "test", "in")
            .Wire("test", "no", "say", "in")
            .Compile());

        Assert.Single(_runtime.OnMessage(Msg("a/b", "{\"ok\":true}"), T0).Debug);
        Assert.Empty(_runtime.OnMessage(Msg("a/b", "{\"fault\":1}"), T0).Debug);
    }

    [Theory]
    [InlineData("gt", "90", "", "{\"v\":90.5}", "yes")]
    [InlineData("gt", "90", "", "{\"v\":90}", "no")]
    [InlineData("gte", "90", "", "{\"v\":90}", "yes")]
    [InlineData("gte", "90", "", "{\"v\":89.9}", "no")]
    [InlineData("lt", "10", "", "{\"v\":9.99}", "yes")]
    [InlineData("lt", "10", "", "{\"v\":10}", "no")]
    [InlineData("lte", "10", "", "{\"v\":10}", "yes")]
    [InlineData("lte", "10", "", "{\"v\":10.01}", "no")]
    [InlineData("eq", "90", "", "{\"v\":90.0}", "yes")]
    [InlineData("eq", "on", "", "{\"v\":\"on\"}", "yes")]
    [InlineData("eq", "on", "", "{\"v\":\"off\"}", "no")]
    [InlineData("neq", "on", "", "{\"v\":\"off\"}", "yes")]
    [InlineData("neq", "on", "", "{\"v\":\"on\"}", "no")]
    [InlineData("between", "10", "20", "{\"v\":10}", "yes")]
    [InlineData("between", "10", "20", "{\"v\":20}", "yes")]
    [InlineData("between", "10", "20", "{\"v\":20.1}", "no")]
    [InlineData("matches", "^k[0-9]$", "", "{\"v\":\"k1\"}", "yes")]
    [InlineData("matches", "^k[0-9]$", "", "{\"v\":\"k12\"}", "no")]
    [InlineData("oneOf", "on, auto", "", "{\"v\":\"auto\"}", "yes")]
    [InlineData("oneOf", "on, auto", "", "{\"v\":\"off\"}", "no")]
    [InlineData("exists", "", "", "{\"v\":null}", "yes")]
    [InlineData("gt", "90", "", "{\"v\":\"hot\"}", "neither")]
    [InlineData("between", "10", "20", "{\"v\":\"warm\"}", "neither")]
    [InlineData("eq", "on", "", "{\"w\":\"on\"}", "neither")]
    public void Each_test_sends_the_message_down_the_branch_it_answers(
        string test, string value, string value2, string payload, string branch)
    {
        Start(new FlowBuilder()
            .Node("in", "mqttIn", new { filter = "a/#" })
            .Node("test", "if", new { field = "$.v", test, value, value2 })
            .Node("yes", "debug")
            .Node("no", "debug")
            .Wire("in", "out", "test", "in")
            .Wire("test", "yes", "yes", "in")
            .Wire("test", "no", "no", "in")
            .Compile());

        var outcome = _runtime.OnMessage(Msg("a/b", payload), T0);

        Assert.Equal(branch, outcome.Debug.SingleOrDefault()?.NodeId ?? "neither");
    }

    [Fact]
    public void A_retained_replay_runs_nothing_unless_the_node_asks_for_it()
    {
        Start(
            new FlowBuilder("plain").Node("in", "mqttIn", new { filter = "a/#" }).Node("say", "debug")
                .Wire("in", "out", "say", "in").Compile(),
            new FlowBuilder("replays").Node("in", "mqttIn", new { filter = "a/#", replay = true }).Node("say", "debug")
                .Wire("in", "out", "say", "in").Compile());

        var outcome = _runtime.OnMessage(Msg("a/b", "1", replay: true), T0);

        Assert.Equal("replays", Assert.Single(outcome.Debug).FlowId);
    }

    [Fact]
    public void A_topic_outside_the_filter_runs_nothing()
    {
        Start(Watch().Compile());

        Assert.True(_runtime.OnMessage(Msg("plant/k1/humidity", "{\"temp\":99}"), T0).IsEmpty);
    }

    // ---- the three loops ----

    [Fact]
    public void For_each_sends_one_message_per_element_with_strings_unquoted()
    {
        Start(new FlowBuilder()
            .Node("go", "inject", new { payload = "{\"ids\":[\"k1\",\"k2\",{\"id\":3}]}" })
            .Node("each", "forEach", new { field = "$.ids" })
            .Node("say", "debug")
            .Wire("go", "out", "each", "in")
            .Wire("each", "out", "say", "in")
            .Compile());

        var outcome = _runtime.Inject("f1", "go", T0);

        Assert.Equal(["k1", "k2", "{\"id\":3}"], outcome.Debug.Select(entry => entry.Text));
    }

    [Fact]
    public void For_each_stops_at_its_ceiling_and_says_so()
    {
        var many = JsonSerializer.Serialize(Enumerable.Range(0, FlowLimits.ForEachElements + 5));
        Start(new FlowBuilder()
            .Node("go", "inject", new { payload = many })
            .Node("each", "forEach", new { field = "" })
            .Node("say", "debug")
            .Wire("go", "out", "each", "in")
            .Wire("each", "out", "say", "in")
            .Compile());

        var outcome = _runtime.Inject("f1", "go", T0);

        Assert.Equal(FlowLimits.ForEachElements, outcome.Debug.Count(entry => entry.Kind == FlowDebugEntry.Message));
        Assert.Single(outcome.Debug, entry => entry.Kind == FlowDebugEntry.Error);
        Assert.Equal(1, Node("each").Errors);
    }

    [Fact]
    public void Repeat_with_no_interval_sends_every_copy_at_once_with_its_index()
    {
        Start(new FlowBuilder()
            .Node("go", "inject")
            .Node("again", "repeat", new { count = 3, seconds = 0 })
            .Node("send", "publish", new { topic = "sim/{{index}}", payload = "x" })
            .Wire("go", "out", "again", "in")
            .Wire("again", "out", "send", "in")
            .Compile());

        var outcome = _runtime.Inject("f1", "go", T0);

        Assert.Equal(["sim/1", "sim/2", "sim/3"], outcome.Publishes.Select(p => p.Request.Topic));
    }

    [Fact]
    public void Repeat_with_an_interval_sends_the_rest_on_the_clock()
    {
        Start(new FlowBuilder()
            .Node("go", "inject")
            .Node("again", "repeat", new { count = 3, seconds = 2 })
            .Node("send", "publish", new { topic = "sim/{{index}}", payload = "x" })
            .Wire("go", "out", "again", "in")
            .Wire("again", "out", "send", "in")
            .Compile());

        Assert.Equal(["sim/1"], _runtime.Inject("f1", "go", T0).Publishes.Select(p => p.Request.Topic));
        Assert.Equal(T0.AddSeconds(2), _runtime.NextDue);

        Assert.Empty(_runtime.OnTick(T0.AddSeconds(1), connected: true).Publishes);
        Assert.Equal(["sim/2"], _runtime.OnTick(T0.AddSeconds(2), connected: true).Publishes.Select(p => p.Request.Topic));
        Assert.Equal(["sim/3"], _runtime.OnTick(T0.AddSeconds(4), connected: true).Publishes.Select(p => p.Request.Topic));
        Assert.Null(_runtime.NextDue);
    }

    [Fact]
    public void Repeat_refuses_a_sequence_past_its_ceiling()
    {
        Start(new FlowBuilder()
            .Node("go", "inject")
            .Node("again", "repeat", new { count = 5, seconds = 60 })
            .Wire("go", "out", "again", "in")
            .Compile());

        for (var i = 0; i < FlowLimits.RepeatSequences; i++) _runtime.Inject("f1", "go", T0);
        var outcome = _runtime.Inject("f1", "go", T0);

        Assert.Single(outcome.Debug, entry => entry.Kind == FlowDebugEntry.Error);
        Assert.Equal(1, Node("again").Errors);
    }

    [Fact]
    public void Every_fires_one_interval_after_deploy_and_counts_its_ticks()
    {
        Start(new FlowBuilder()
            .Node("tick", "every", new { seconds = 2, topic = "", payload = "[\"k1\"]" })
            .Node("send", "publish", new { topic = "sim/{{index}}", payload = "{{payload}}" })
            .Wire("tick", "out", "send", "in")
            .Compile());

        Assert.Equal(T0.AddSeconds(2), _runtime.NextDue);
        Assert.Empty(_runtime.OnTick(T0.AddSeconds(1), connected: true).Publishes);

        var first = Assert.Single(_runtime.OnTick(T0.AddSeconds(2), connected: true).Publishes);
        var second = Assert.Single(_runtime.OnTick(T0.AddSeconds(4), connected: true).Publishes);

        Assert.Equal("sim/1", first.Request.Topic);
        Assert.Equal("[\"k1\"]", Text(first));
        Assert.Equal("sim/2", second.Request.Topic);
        Assert.Equal(2, Node("tick").Count);
    }

    [Fact]
    public void Every_does_not_burst_after_a_stall()
    {
        Start(new FlowBuilder()
            .Node("tick", "every", new { seconds = 1 })
            .Node("say", "debug")
            .Wire("tick", "out", "say", "in")
            .Compile());

        var outcome = _runtime.OnTick(T0.AddSeconds(30), connected: true);

        Assert.Single(outcome.Debug);
        Assert.Equal(T0.AddSeconds(31), _runtime.NextDue);
    }

    [Fact]
    public void Repeat_does_not_burst_after_a_stall()
    {
        Start(new FlowBuilder()
            .Node("go", "inject")
            .Node("again", "repeat", new { count = 5, seconds = 1 })
            .Node("send", "publish", new { topic = "sim/{{index}}", payload = "x" })
            .Wire("go", "out", "again", "in")
            .Wire("again", "out", "send", "in")
            .Compile());
        _runtime.Inject("f1", "go", T0);

        var outcome = _runtime.OnTick(T0.AddSeconds(30), connected: true);

        Assert.Equal(["sim/2"], outcome.Publishes.Select(p => p.Request.Topic));
        Assert.Equal(T0.AddSeconds(31), _runtime.NextDue);
    }

    [Fact]
    public void A_changed_flow_leaves_its_old_timer_behind()
    {
        static FlowBuilder Ticker(string payload) => new FlowBuilder()
            .Node("tick", "every", new { seconds = 2, payload })
            .Node("say", "debug")
            .Wire("tick", "out", "say", "in");

        Start(Ticker("old").Compile());
        _runtime.Deploy([Ticker("new").Compile()], ["f1"], T0.AddSeconds(1));

        // The old timer was due at +2 and the new one is due at +3: only the new one may speak, once
        // an interval.
        Assert.Empty(_runtime.OnTick(T0.AddSeconds(2), connected: true).Debug);
        Assert.Equal(["new"], _runtime.OnTick(T0.AddSeconds(3), connected: true).Debug.Select(entry => entry.Text));
        Assert.Equal(["new"], _runtime.OnTick(T0.AddSeconds(5), connected: true).Debug.Select(entry => entry.Text));
    }

    // Taken, not left to be skipped when it comes due: an Every's next tick can be a day away, and it
    // holds its message all that time. The old tick is due at +10 and the new one at +11, so what is
    // due next says which of them is still queued.
    [Fact]
    public void A_redeployed_flow_takes_its_old_timers_with_it()
    {
        static FlowBuilder Ticker(string payload) => new FlowBuilder()
            .Node("tick", "every", new { seconds = 10, payload })
            .Node("say", "debug")
            .Wire("tick", "out", "say", "in");

        Start(Ticker("old").Compile());
        _runtime.Deploy([Ticker("new").Compile()], ["f1"], T0.AddSeconds(1));

        Assert.Equal(T0.AddSeconds(11), _runtime.NextDue);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void A_flow_turned_off_or_taken_away_takes_its_timers_and_its_repeats_with_it(bool keptInTheFile)
    {
        FlowBuilder Flow() => new FlowBuilder()
            .Node("tick", "every", new { seconds = 10 })
            .Node("go", "inject")
            .Node("again", "repeat", new { count = 3, seconds = 60 })
            .Node("say", "debug")
            .Wire("tick", "out", "say", "in")
            .Wire("go", "out", "again", "in")
            .Wire("again", "out", "say", "in");

        Start(Flow().Compile());
        _runtime.Inject("f1", "go", T0);

        if (keptInTheFile) _runtime.Deploy([Flow().Off().Compile()], ["f1"], T0.AddSeconds(1));
        else _runtime.Deploy([], [], T0.AddSeconds(1));

        Assert.Null(_runtime.NextDue);
    }

    [Fact]
    public void A_repeat_sequence_gives_its_place_back_when_its_last_copy_goes()
    {
        Start(new FlowBuilder()
            .Node("go", "inject")
            .Node("again", "repeat", new { count = 2, seconds = 1 })
            .Wire("go", "out", "again", "in")
            .Compile());

        for (var i = 0; i < FlowLimits.RepeatSequences; i++) _runtime.Inject("f1", "go", T0);
        _runtime.OnTick(T0.AddSeconds(1), connected: true);
        _runtime.Inject("f1", "go", T0.AddSeconds(1));

        Assert.Equal(0, Node("again").Errors);
        Assert.Equal(2 * FlowLimits.RepeatSequences + 1, Node("again").Outs["out"]);
    }

    // ---- inject and debug ----

    [Fact]
    public void Inject_sends_its_topic_and_payload_and_debug_prints_them()
    {
        Start(new FlowBuilder()
            .Node("go", "inject", new { topic = "plant/k1/cmd", payload = "{\"fan\":\"on\"}" })
            .Node("say", "debug")
            .Wire("go", "out", "say", "in")
            .Compile());

        var entry = Assert.Single(_runtime.Inject("f1", "go", T0).Debug);

        Assert.Equal(("f1", "say", "plant/k1/cmd", "{\"fan\":\"on\"}", FlowDebugEntry.Message),
            (entry.FlowId, entry.NodeId, entry.Topic, entry.Text, entry.Kind));
        Assert.True(_runtime.Injectable().Contains(("f1", "go")));
        Assert.True(_runtime.Inject("f1", "nope", T0).IsEmpty);
    }

    // ---- what keeps a flow from running away ----

    private static FlowBuilder Loop(string id) => new FlowBuilder(id)
        .Node("in", "mqttIn", new { filter = "plant/k1/cmd" })
        .Node("send", "publish", new { topic = "plant/k1/cmd", payload = "{{payload}}" })
        .Wire("in", "out", "send", "in");

    [Fact]
    public void A_flow_does_not_hear_its_own_publish_but_another_flow_does()
    {
        Start(Loop("loop").Compile(),
            new FlowBuilder("watch").Node("in", "mqttIn", new { filter = "plant/#" }).Node("say", "debug")
                .Wire("in", "out", "say", "in").Compile());

        var first = _runtime.OnMessage(Msg("plant/k1/cmd", "on"), T0);
        Assert.Single(first.Publishes);

        var echo = _runtime.OnMessage(Msg("plant/k1/cmd", "on"), T0.AddSeconds(1));

        Assert.Empty(echo.Publishes);
        Assert.Equal("watch", Assert.Single(echo.Debug).FlowId);
        Assert.Equal(1, Node("in", "loop").Outs["echo"]);
    }

    [Fact]
    public void The_echo_window_closes_after_five_seconds()
    {
        Start(Loop("loop").Compile());
        _runtime.OnMessage(Msg("plant/k1/cmd", "on"), T0);

        var later = _runtime.OnMessage(Msg("plant/k1/cmd", "on"), T0.AddSeconds(6));

        Assert.Single(later.Publishes);
    }

    [Fact]
    public void A_flow_knows_its_own_publish_when_it_comes_back_as_base64()
    {
        Start(new FlowBuilder("loop")
            .Node("in", "mqttIn", new { filter = "dev/+/cmd" })
            .Node("send", "publish", new { topic = "dev/{{topic[1]}}/cmd", payload = "\u0006" })
            .Wire("in", "out", "send", "in")
            .Compile());
        Assert.Single(_runtime.OnMessage(Msg("dev/d1/cmd", "go"), T0).Publishes);

        // What the broker hands back: a control byte is not text, so the one byte arrives as base64.
        var echo = new MqttMessage("dev/d1/cmd", Convert.ToBase64String([0x06]), MqttMessage.Base64, 0, false, T0);

        Assert.Empty(_runtime.OnMessage(echo, T0.AddSeconds(1)).Publishes);
        Assert.Equal(1, Node("in", "loop").Outs["echo"]);
    }

    [Fact]
    public void An_arrival_marked_base64_that_does_not_decode_is_compared_as_text()
    {
        Start(Loop("loop").Compile());
        _runtime.OnMessage(Msg("plant/k1/cmd", "on!"), T0);

        var echo = new MqttMessage("plant/k1/cmd", "on!", MqttMessage.Base64, 0, false, T0);

        Assert.Empty(_runtime.OnMessage(echo, T0.AddSeconds(1)).Publishes);
        Assert.Equal(1, Node("in", "loop").Outs["echo"]);
    }

    [Fact]
    public void Publishes_past_the_rate_limit_are_dropped_and_counted()
    {
        Start(new FlowBuilder()
            .Node("go", "inject")
            .Node("again", "repeat", new { count = 60, seconds = 0 })
            .Node("send", "publish", new { topic = "sim/x", payload = "{{index}}" })
            .Wire("go", "out", "again", "in")
            .Wire("again", "out", "send", "in")
            .Compile());

        var outcome = _runtime.Inject("f1", "go", T0);

        Assert.Equal(FlowLimits.PublishesPerSecond, outcome.Publishes.Count);
        Assert.Equal(60 - FlowLimits.PublishesPerSecond, Node("send").Errors);

        // A second later the bucket has filled again.
        Assert.Equal(FlowLimits.PublishesPerSecond, _runtime.Inject("f1", "go", T0.AddSeconds(1)).Publishes.Count);
    }

    [Fact]
    public void A_topic_that_expands_to_a_wildcard_is_not_published()
    {
        Start(new FlowBuilder()
            .Node("go", "inject", new { payload = "{\"id\":\"#\"}" })
            .Node("send", "publish", new { topic = "plant/{{$.id}}/cmd", payload = "x" })
            .Wire("go", "out", "send", "in")
            .Compile());

        Assert.Empty(_runtime.Inject("f1", "go", T0).Publishes);
        Assert.Equal(1, Node("send").Errors);
    }

    [Fact]
    public void A_topic_that_renders_longer_than_MQTT_allows_is_not_published()
    {
        Start(new FlowBuilder()
            .Node("go", "inject", new { payload = new string('k', FlowLimits.TopicBytes) })
            .Node("send", "publish", new { topic = "plant/{{payload}}", payload = "x" })
            .Wire("go", "out", "send", "in")
            .Compile());

        Assert.Empty(_runtime.Inject("f1", "go", T0).Publishes);
        Assert.Equal(1, Node("send").Errors);
        Assert.StartsWith("The topic came out longer than", Node("send").Note);
    }

    [Fact]
    public void A_payload_that_renders_past_64_KB_is_not_published_and_is_counted()
    {
        Start(new FlowBuilder()
            .Node("go", "inject", new { payload = new string('x', FlowLimits.PayloadBytes / 2 + 1) })
            .Node("send", "publish", new { topic = "sim/x", payload = "{{payload}}{{payload}}" })
            .Wire("go", "out", "send", "in")
            .Compile());

        Assert.Empty(_runtime.Inject("f1", "go", T0).Publishes);
        Assert.Equal(1, Node("send").Errors);
        Assert.Equal("The payload came out larger than 64 KB and was not published.", Node("send").Note);
    }

    // Every publish the rate drops, and every one while there is no link, would otherwise pay for a
    // render first. The random number in the payload counts the renders.
    [Fact]
    public void A_publish_the_link_or_the_rate_would_refuse_is_never_rendered()
    {
        var random = new CountingRandom(7);
        var runtime = new FlowRuntime(random);
        var flow = new FlowBuilder()
            .Node("go", "inject")
            .Node("again", "repeat", new { count = 60, seconds = 0 })
            .Node("send", "publish", new { topic = "sim/x", payload = "{{random(0,1)}}" })
            .Wire("go", "out", "again", "in")
            .Wire("again", "out", "send", "in")
            .Compile();
        runtime.Deploy([flow], ["f1"], T0);
        runtime.OnTick(T0, connected: true);

        Assert.Equal(FlowLimits.PublishesPerSecond, runtime.Inject("f1", "go", T0).Publishes.Count);
        Assert.Equal(FlowLimits.PublishesPerSecond, random.Draws);

        runtime.OnTick(T0.AddSeconds(2), connected: false);
        runtime.Inject("f1", "go", T0.AddSeconds(2));

        Assert.Equal(FlowLimits.PublishesPerSecond, random.Draws);
    }

    [Fact]
    public void An_alarms_reason_is_cut_at_200_characters_and_its_sample_at_4_KB()
    {
        Start(new FlowBuilder()
            .Node("go", "inject", new { topic = "plant/k1/temp", payload = new string('p', 5_000) })
            .Node("hot", "alarm", new { name = "Hot", severity = "warn", reason = "{{payload}}" })
            .Wire("go", "out", "hot", "raise")
            .Compile());

        var alarm = Assert.Single(_runtime.Inject("f1", "go", T0).Raised);

        Assert.Equal(new string('p', FlowLimits.ReasonLength), alarm.Reason);
        Assert.Equal(new string('p', FlowLimits.SampleLength), alarm.Sample);
    }

    /// <summary>A Random that counts its draws: each {{random}} a render fills is one.</summary>
    private sealed class CountingRandom(int seed) : Random(seed)
    {
        public int Draws { get; private set; }

        public override double NextDouble()
        {
            Draws++;
            return base.NextDouble();
        }
    }

    [Fact]
    public void Nothing_is_published_while_the_link_is_down()
    {
        Start(new FlowBuilder()
            .Node("go", "inject")
            .Node("send", "publish", new { topic = "sim/x", payload = "x" })
            .Wire("go", "out", "send", "in")
            .Compile());
        _runtime.OnTick(T0, connected: false);

        Assert.Empty(_runtime.Inject("f1", "go", T0).Publishes);
        Assert.Contains("link", Node("send").Note);
    }

    [Fact]
    public void An_event_that_runs_past_its_budget_is_stopped_and_faults_the_flow()
    {
        var flow = new FlowBuilder()
            .Node("go", "inject", new { payload = JsonSerializer.Serialize(Enumerable.Range(0, 1000)) })
            .Node("each", "forEach", new { field = "" })
            .Wire("go", "out", "each", "in");

        // Eleven nodes per element, a thousand elements: eleven thousand runs, past the ten.
        for (var i = 0; i < 11; i++) flow.Node($"say{i}", "debug").Wire("each", "out", $"say{i}", "in");
        Start(flow.Compile());

        var outcome = _runtime.Inject("f1", "go", T0);

        Assert.Contains(outcome.Debug, entry => entry.Kind == FlowDebugEntry.Error && entry.NodeId == "go");
        Assert.True(outcome.Debug.Count(entry => entry.Kind == FlowDebugEntry.Message) < FlowLimits.StepsPerEvent);
        Assert.Equal(1, _runtime.Status().Flows.Single().Faults);
    }

    // Each hostile text costs the pattern its 50 ms. Carried on past the first, a For each of a
    // thousand of them would hold the pump for fifty seconds, and the step budget for eight minutes.
    [Fact]
    public void A_pattern_that_runs_out_of_time_ends_its_event_and_says_why()
    {
        Start(new FlowBuilder()
            .Node("go", "inject", new { payload = JsonSerializer.Serialize(Enumerable.Repeat(HostilePatterns.Payload, 3)) })
            .Node("each", "forEach", new { field = "" })
            .Node("test", "if", new { field = "", test = "matches", value = HostilePatterns.Catastrophic })
            .Node("say", "debug")
            .Wire("go", "out", "each", "in")
            .Wire("each", "out", "test", "in")
            .Wire("each", "out", "say", "in")
            .Compile());

        var outcome = _runtime.Inject("f1", "go", T0);

        // The first element's pattern, and nothing after it: not the Debug node wired after the If,
        // and not the next two elements.
        Assert.Equal(1, Node("test").Count);
        Assert.Equal(1, Node("test").Errors);
        Assert.Equal("The pattern took longer than 50 ms, so the event was stopped.", Node("test").Note);
        Assert.Equal(FlowDebugEntry.Error, Assert.Single(outcome.Debug).Kind);
        Assert.Equal(0, _runtime.Status().Flows.Single().Faults);
    }

    // An arrival runs once for each MQTT in node it matches, and three of them on one filter, all wired
    // to one hostile If, would cost the pattern its 50 ms three times over for every message. The
    // other flow is a drawing of its own: what it makes of the arrival is not this one's to stop.
    [Fact]
    public void A_pattern_that_runs_out_of_time_stops_the_whole_arrival_in_its_flow()
    {
        var hostile = new FlowBuilder()
            .Node("test", "if", new { field = "", test = "matches", value = HostilePatterns.Catastrophic });
        for (var i = 0; i < 3; i++)
            hostile.Node($"in{i}", "mqttIn", new { filter = "plant/+/text" }).Wire($"in{i}", "out", "test", "in");

        Start(hostile.Compile(), new FlowBuilder("f2", "Other")
            .Node("in", "mqttIn", new { filter = "plant/+/text" })
            .Node("say", "debug")
            .Wire("in", "out", "say", "in")
            .Compile());

        var outcome = _runtime.OnMessage(Msg("plant/k1/text", HostilePatterns.Payload), T0);

        Assert.Equal(1, Node("test").Count);
        Assert.Equal(1, Node("test").Errors);
        Assert.Equal(1, Node("say", "f2").Count);
        Assert.Single(outcome.Debug, entry => entry.Kind == FlowDebugEntry.Error);
    }

    // The first copy goes at once, and the event it started was stopped: the copies after it would
    // each start the same event again, a second apart, and stop it the same way.
    [Fact]
    public void A_repeat_whose_event_was_stopped_schedules_no_copies()
    {
        Start(new FlowBuilder()
            .Node("go", "inject", new { payload = HostilePatterns.Payload })
            .Node("again", "repeat", new { count = 3, seconds = 1 })
            .Node("test", "if", new { field = "", test = "matches", value = HostilePatterns.Catastrophic })
            .Wire("go", "out", "again", "in")
            .Wire("again", "out", "test", "in")
            .Compile());

        _runtime.Inject("f1", "go", T0);

        Assert.Equal(1, Node("test").Errors);
        Assert.Null(_runtime.NextDue);
    }

    [Fact]
    public void A_publish_that_failed_on_the_way_out_is_counted_on_its_node()
    {
        Start(Watch().Compile());

        var outcome = _runtime.PublishFailed("f1", "fan", "No broker link, so nothing was published.", T0);

        Assert.Equal(1, Node("fan").Errors);
        Assert.Equal("No broker link, so nothing was published.", Node("fan").Note);
        Assert.Equal(FlowDebugEntry.Error, Assert.Single(outcome.Debug).Kind);
    }

    [Fact]
    public void Past_the_ceiling_a_new_alarm_is_refused_and_the_ones_up_carry_on()
    {
        Start(new FlowBuilder()
            .Node("in", "mqttIn", new { filter = "plant/+/temp" })
            .Node("test", "if", new { field = "$.temp", test = "gt", value = "90" })
            .Node("hot", "alarm", new { name = "Hot", severity = "critical" })
            .Wire("in", "out", "test", "in")
            .Wire("test", "yes", "hot", "raise")
            .Wire("test", "no", "hot", "clear")
            .Compile());

        for (var i = 0; i < FlowLimits.StandingAlarms; i++)
            _runtime.OnMessage(Msg($"plant/k{i}/temp", "{\"temp\":95}"), T0);

        var refused = _runtime.OnMessage(Msg("plant/late/temp", "{\"temp\":95}"), T0);

        Assert.Empty(refused.Raised);
        Assert.Equal(FlowDebugEntry.Error, Assert.Single(refused.Debug).Kind);
        Assert.Equal(1, Node("hot").Errors);
        Assert.Equal("Too many alarms are up; this one was not raised.", Node("hot").Note);
        Assert.Equal(FlowLimits.StandingAlarms, _runtime.Alarms().Active.Count);

        // One already up still counts and still clears, and the place a clear gives back is taken.
        _runtime.OnMessage(Msg("plant/k0/temp", "{\"temp\":96}"), T0.AddSeconds(1));
        Assert.Equal(2, _runtime.Alarms().Active.Single(alarm => alarm.Topic == "plant/k0/temp").Count);
        Assert.Single(_runtime.OnMessage(Msg("plant/k1/temp", "{\"temp\":50}"), T0.AddSeconds(1)).Resolved);
        Assert.Single(_runtime.OnMessage(Msg("plant/late/temp", "{\"temp\":95}"), T0.AddSeconds(1)).Raised);
    }

    // ---- what the engine asks of it ----

    [Fact]
    public void The_filters_are_every_running_input_once()
    {
        Start(Watch("a").Compile(), Watch("b").Compile(),
            new FlowBuilder("c").Node("in", "mqttIn", new { filter = "lab/#" }).Compile());

        Assert.Equal(["lab/#", "plant/+/temp"], _runtime.Filters().Order());
    }

    [Fact]
    public void Of_two_flows_with_one_id_the_first_is_the_one_that_counts()
    {
        static CompiledFlow Twin(string filter, bool on = true)
        {
            var flow = new FlowBuilder("twin").Node("in", "mqttIn", new { filter });
            return (on ? flow : flow.Off()).Compile();
        }

        _runtime.Deploy([Twin("a/#"), Twin("b/#")], ["twin"], T0);
        Assert.Equal(["a/#"], _runtime.Filters());

        _runtime.Deploy([Twin("a/#", on: false), Twin("b/#")], ["twin"], T0);
        Assert.Empty(_runtime.Filters());
    }

    [Fact]
    public void A_refused_filter_is_said_on_the_inputs_that_asked_for_it()
    {
        Start(Watch().Compile());

        _runtime.MarkRefused(["plant/+/temp"]);

        Assert.Equal(1, Node("in").Errors);
        Assert.Contains("refused", Node("in").Note);
    }

    [Fact]
    public void Every_change_moves_the_version()
    {
        Start(Watch().Compile());
        var before = _runtime.Version;

        _runtime.OnMessage(Msg("plant/k1/temp", "{\"temp\":50}"), T0);

        Assert.True(_runtime.Version > before);
    }

    [Fact]
    public void Status_counts_per_port()
    {
        Start(Watch().Compile());
        _runtime.OnMessage(Msg("plant/k1/temp", "{\"temp\":94}"), T0);
        _runtime.OnMessage(Msg("plant/k2/temp", "{\"temp\":70}"), T0);

        Assert.Equal(2, Node("in").Count);
        Assert.Equal(1, Node("test").Outs["yes"]);
        Assert.Equal(1, Node("test").Outs["no"]);
        Assert.Equal(1, Node("fan").Outs["sent"]);
        Assert.Equal(1, Node("hot").Outs["raised"]);
        Assert.Equal("plant/k1/temp", Assert.Single(Node("hot").Standing).Topic);
    }

    // ---- what stands under a node, and in the debug strip ----

    [Fact]
    public void A_note_is_one_line_that_fits_under_its_node()
    {
        Start(Watch().Compile());

        // A level long enough that the rendered topic and the alarm's reason both run past a note.
        _runtime.OnMessage(Msg($"plant/{new string('k', 120)}/temp", "{\"temp\":94.2}"), T0);

        Assert.Equal(1, Node("fan").Outs["sent"]);
        Assert.Equal(1, Node("hot").Outs["raised"]);
        Assert.All(_runtime.Status().Flows.Single().Nodes, node =>
            Assert.True(node.Note is null || node.Note.Length <= FlowLimits.NoteLength, $"{node.Id}: {node.Note}"));
    }

    // A note shows eighty characters and must cost about that: the line endings are replaced in what
    // is kept, not in a copy of the whole payload made first. The text is the same either way, so the
    // allocation is the proof — two megabyte copies against a few hundred bytes.
    [Fact]
    public void A_note_costs_what_it_shows_and_not_a_copy_of_the_payload()
    {
        Start(new FlowBuilder()
            .Node("in", "mqttIn", new { filter = "a/#" })
            .Node("say", "debug")
            .Wire("in", "out", "say", "in")
            .Compile());
        _runtime.OnMessage(Msg("a/b", "warming up"), T0);

        var lines = Msg("a/b", string.Concat(Enumerable.Repeat("a line\n", 150_000)));
        var before = GC.GetAllocatedBytesForCurrentThread();
        _runtime.OnMessage(lines, T0);
        var allocated = GC.GetAllocatedBytesForCurrentThread() - before;

        Assert.StartsWith("a line a line ", Node("say").Note);
        Assert.Equal(FlowLimits.NoteLength, Node("say").Note!.Length);
        Assert.True(allocated < 64 * 1024, $"{allocated:N0} bytes were allocated to run one message into two notes.");
    }

    // One read, and every Alarm node its own list: oldest first, at most twenty. Raised newest first
    // here, so the order is the read's own and not the order they came in.
    [Fact]
    public void Each_alarm_node_lists_its_own_standing_alarms_oldest_first_and_at_most_twenty()
    {
        static FlowBuilder Pair(string id) => new FlowBuilder(id)
            .Node("in", "mqttIn", new { filter = $"{id}/+/temp" })
            .Node("hot", "alarm", new { name = "Hot", severity = "warn" })
            .Node("cold", "alarm", new { name = "Cold", severity = "info" })
            .Wire("in", "out", "hot", "raise")
            .Wire("in", "out", "cold", "raise");
        Start(Pair("a").Compile(), Pair("b").Compile());

        for (var i = 0; i < 25; i++) _runtime.OnMessage(Msg($"a/k{i}/temp", "1"), T0.AddSeconds(100 - i));
        _runtime.OnMessage(Msg("b/k0/temp", "1"), T0);

        string[] oldestTwenty = [.. Enumerable.Range(5, 20).Reverse().Select(i => $"a/k{i}/temp")];

        Assert.Equal(oldestTwenty, Node("hot", "a").Standing.Select(standing => standing.Topic));
        Assert.Equal(oldestTwenty, Node("cold", "a").Standing.Select(standing => standing.Topic));
        Assert.Equal(["b/k0/temp"], Node("hot", "b").Standing.Select(standing => standing.Topic));
        Assert.Empty(Node("in", "a").Standing);
    }

    [Fact]
    public void An_error_carrying_a_rendered_topic_is_cut_to_an_excerpt()
    {
        Start(new FlowBuilder()
            .Node("go", "inject", new { payload = new string('x', 5000) + "/#" })
            .Node("send", "publish", new { topic = "{{payload}}", payload = "x" })
            .Wire("go", "out", "send", "in")
            .Compile());

        var entry = Assert.Single(_runtime.Inject("f1", "go", T0).Debug);

        Assert.Equal(FlowDebugEntry.Error, entry.Kind);
        Assert.True(entry.Text.Length <= FlowLimits.DebugExcerpt);
        Assert.True(Node("send").Note!.Length <= FlowLimits.NoteLength);
    }

    [Fact]
    public void A_debug_line_carries_no_more_of_a_topic_than_an_excerpt()
    {
        Start(new FlowBuilder()
            .Node("in", "mqttIn", new { filter = "x/#" })
            .Node("say", "debug")
            .Node("send", "publish", new { topic = "{{topic}}/out", payload = "x" })
            .Wire("in", "out", "say", "in")
            .Wire("in", "out", "send", "in")
            .Compile());
        _runtime.OnTick(T0, connected: false);

        var outcome = _runtime.OnMessage(Msg("x/" + new string('k', 5000), "1"), T0);

        // The Debug node's line, and the Publish node's error, which carries the topic it rendered.
        Assert.Equal([FlowDebugEntry.Message, FlowDebugEntry.Error], outcome.Debug.Select(entry => entry.Kind));
        Assert.All(outcome.Debug, entry => Assert.True(entry.Topic.Length <= FlowLimits.DebugExcerpt, entry.NodeId));
    }

    [Fact]
    public void For_each_shows_the_array_it_walked_rather_than_an_earlier_skip()
    {
        Start(new FlowBuilder()
            .Node("in", "mqttIn", new { filter = "a/#" })
            .Node("each", "forEach", new { field = "$.ids" })
            .Wire("in", "out", "each", "in")
            .Compile());

        _runtime.OnMessage(Msg("a/b", "{\"ids\":7}"), T0);
        Assert.Equal("not an array", Node("each").Note);

        _runtime.OnMessage(Msg("a/b", "{\"ids\":[\"k1\",\"k2\"]}"), T0);
        Assert.Equal("[\"k1\",\"k2\"]", Node("each").Note);
    }
}
