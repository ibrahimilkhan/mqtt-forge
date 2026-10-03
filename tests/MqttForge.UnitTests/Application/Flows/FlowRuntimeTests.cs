using System.Globalization;
using System.Text;
using MqttForge.Application.Flows;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;
using MqttForge.UnitTests.Application.Alerts;

namespace MqttForge.UnitTests.Application.Flows;

public class FlowRuntimeTests
{
    private static readonly DateTimeOffset T0 = new(2026, 10, 3, 9, 0, 0, TimeSpan.Zero);

    private readonly FlowRuntime _runtime = new(new Random(7));

    public FlowRuntimeTests() => _runtime.OnTick(T0, connected: true);

    private FlowOutcome Activate(params CompiledFlow[] flows) =>
        _runtime.Deploy(flows, [.. flows.Select(flow => flow.Id)], T0);

    private static MqttMessage Msg(string topic, string payload, bool replay = false) =>
        new(topic, payload, "text", 0, false, T0, Replay: replay);

    private FlowRunStatus Run(FlowRunKind kind = FlowRunKind.Active, string flowId = "f1") =>
        _runtime.Status().Runs.Single(run => run.FlowId == flowId && run.Kind == kind);

    private FlowNodeStatus Node(string id, FlowRunKind kind = FlowRunKind.Active) =>
        Run(kind).Nodes.Single(node => node.Id == id);

    private static string Text(FlowPublish publish) => Encoding.UTF8.GetString(publish.Request.Payload);

    private static IEnumerable<string> Topics(FlowOutcome outcome) => outcome.Publishes.Select(publish => publish.Request.Topic);

    /// <summary>Start → the steps given, one after another → End.</summary>
    private static ChartBuilder Line(params (string Id, string Type, object? Config)[] steps)
    {
        var chart = new ChartBuilder().Node("start", "start").Node("end", "end");
        foreach (var (id, type, config) in steps) chart.Node(id, type, config);

        return chart.Then(["start", .. steps.Select(step => step.Id), "end"]);
    }

    /// <summary>Start → a loop whose body is the steps given, back to its next; done → End.</summary>
    private static ChartBuilder Body(string type, object config, params (string Id, string Type, object? Config)[] steps)
    {
        var chart = new ChartBuilder().Node("start", "start").Node("loop", type, config).Node("end", "end")
            .Then("start", "loop").Wire("loop", "done", "end");

        if (steps.Length == 0) return chart.Wire("loop", "body", "loop", "next");

        foreach (var (id, stepType, stepConfig) in steps) chart.Node(id, stepType, stepConfig);
        chart.Wire("loop", "body", steps[0].Id);
        for (var i = 0; i + 1 < steps.Length; i++) chart.Wire(steps[i].Id, "out", steps[i + 1].Id);

        return chart.Wire(steps[^1].Id, "out", "loop", "next");
    }

    /// <summary>Ticks at <paramref name="at"/> while a run has steps left over, gathering what each tick decided.</summary>
    private List<FlowOutcome> Settle(DateTimeOffset? at = null)
    {
        var outcomes = new List<FlowOutcome>();
        for (var i = 0; i < 1_000 && _runtime.NextDue is { } due && due <= (at ?? T0); i++)
            outcomes.Add(_runtime.OnTick(at ?? T0, connected: true));

        return outcomes;
    }

    /// <summary>A monitor: forever, read a temperature; over the limit raise "Hot" and send the fan on once; under it clear.</summary>
    private static ChartBuilder Watch(string limit = "90", string level = "critical") => new ChartBuilder()
        .Var("limit", limit)
        .Node("start", "start").Node("loop", "for", new { forever = true })
        .Node("read", "mqttIn", new { filter = "plant/+/temp" })
        .Node("test", "if", new { field = "$.temp", test = "gt", value = "{{var.limit}}" })
        .Node("hot", "alarmRaise", new { name = "Hot", level, reason = "{{topic[1]}} at {{$.temp}}", value = "$.temp" })
        .Node("cool", "alarmClear", new { alarm = "hot" })
        .Node("fan", "publish", new { topic = "plant/{{topic[1]}}/cmd", payload = "on" })
        .Node("end", "end")
        .Then("start", "loop").Wire("loop", "body", "read").Then("read", "test")
        .Wire("test", "yes", "hot").Wire("hot", "raised", "fan").Wire("fan", "out", "loop", "next").Wire("hot", "up", "loop", "next")
        .Wire("test", "no", "cool").Wire("cool", "cleared", "loop", "next").Wire("cool", "none", "loop", "next")
        .Wire("loop", "done", "end");

    // ---- a run, from Start to End ----

    [Fact]
    public void An_active_flow_runs_from_start_to_end_once()
    {
        var outcome = Activate(Line(("pub", "publish", new { topic = "plant/k1/cmd", payload = "on" })).Compile());

        var publish = Assert.Single(outcome.Publishes);
        Assert.Equal("plant/k1/cmd", publish.Request.Topic);
        Assert.Equal("on", Text(publish));
        Assert.Equal(new FlowRunKey("f1", FlowRunKind.Active), publish.Run);

        var run = Run();
        Assert.Equal(FlowRunState.Finished, run.State);
        Assert.Equal("end", run.At);
        Assert.Null(run.Waiting);
        Assert.Equal(1, Node("pub").Count);
        Assert.Equal(1, Node("pub").Outs["sent"]);

        // Finished, and still switched on: it runs again from Start at the next start of the application.
        Assert.Equal(["f1"], _runtime.Active());
    }

    [Fact]
    public void A_flow_that_is_off_does_not_run()
    {
        Assert.Empty(Activate(Line(("pub", "publish", new { topic = "a/b" })).Off().Compile()).Publishes);
        Assert.Empty(_runtime.Status().Runs);
        Assert.Empty(_runtime.Active());
    }

    [Fact]
    public void Debug_prints_the_message_and_the_run_goes_on()
    {
        var outcome = Activate(Line(("say", "debug", null), ("pub", "publish", new { topic = "a/b" })).Compile());

        var line = Assert.Single(outcome.Debug);
        Assert.Equal(FlowDebugEntry.Message, line.Kind);
        Assert.Equal("say", line.NodeId);
        Assert.False(line.Test);
        Assert.Single(outcome.Publishes);
    }

    // ---- loops ----

    [Fact]
    public void For_runs_its_body_one_turn_after_another_with_the_turn_as_index()
    {
        var outcome = Activate(Body("for", new { times = "3" }, ("pub", "publish", new { topic = "count/{{index}}" })).Compile());

        Assert.Equal(["count/1", "count/2", "count/3"], Topics(outcome));
        Assert.Equal(FlowRunState.Finished, Run().State);
    }

    [Fact]
    public void For_zero_times_goes_straight_to_done()
    {
        Assert.Empty(Activate(Body("for", new { times = "0" }, ("pub", "publish", new { topic = "a/b" })).Compile()).Publishes);
        Assert.Equal(FlowRunState.Finished, Run().State);
    }

    [Fact]
    public void For_may_take_its_times_from_a_variable()
    {
        var chart = Body("for", new { times = "{{var.n}}" }, ("pub", "publish", new { topic = "a/{{index}}" })).Var("n", "2");

        Assert.Equal(["a/1", "a/2"], Topics(Activate(chart.Compile())));
    }

    [Fact]
    public void A_wait_in_a_loop_spaces_its_turns()
    {
        var chart = Body("for", new { times = "3" },
            ("pause", "wait", new { seconds = "1" }),
            ("pub", "publish", new { topic = "tick/{{index}}" }));

        Assert.Empty(Activate(chart.Compile()).Publishes);
        Assert.Equal(new FlowWaiting(T0.AddSeconds(1), null), Run().Waiting);
        Assert.Equal("pause", Run().At);

        Assert.Equal(["tick/1"], Topics(_runtime.OnTick(T0.AddSeconds(1), connected: true)));
        Assert.Empty(_runtime.OnTick(T0.AddSeconds(1.5), connected: true).Publishes);
        Assert.Equal(["tick/2"], Topics(_runtime.OnTick(T0.AddSeconds(2), connected: true)));
        Assert.Equal(["tick/3"], Topics(_runtime.OnTick(T0.AddSeconds(3), connected: true)));
        Assert.Equal(FlowRunState.Finished, Run().State);
    }

    [Fact]
    public void A_forever_loop_with_a_wait_keeps_going()
    {
        var chart = Body("for", new { forever = true },
            ("pause", "wait", new { seconds = "2" }),
            ("pub", "publish", new { topic = "sim/ping" }));
        Activate(chart.Compile());

        for (var tick = 1; tick <= 5; tick++)
            Assert.Single(_runtime.OnTick(T0.AddSeconds(2 * tick), connected: true).Publishes);

        Assert.Equal(FlowRunState.Waiting, Run().State);
    }

    [Fact]
    public void A_forever_turn_that_did_not_wait_stops_the_run()
    {
        // The body holds a Wait, so it compiles; the If takes this turn round it.
        var chart = new ChartBuilder()
            .Node("start", "start").Node("loop", "for", new { forever = true })
            .Node("test", "if", new { field = "$.go", test = "exists" })
            .Node("pause", "wait", new { seconds = "1" }).Node("say", "debug").Node("end", "end")
            .Then("start", "loop").Wire("loop", "body", "test")
            .Wire("test", "yes", "pause").Wire("pause", "out", "loop", "next")
            .Wire("test", "no", "say").Wire("say", "out", "loop", "next")
            .Wire("loop", "done", "end");

        var outcome = Activate(chart.Compile());

        var run = Run();
        Assert.Equal(FlowRunState.Stopped, run.State);
        Assert.Contains("without waiting", run.Fault);
        Assert.Contains(outcome.Debug, line => line.Kind == FlowDebugEntry.Error && line.NodeId == "loop");
        Assert.Empty(_runtime.Filters());
    }

    [Fact]
    public void For_each_walks_an_array_one_element_a_turn()
    {
        var chart = Body("forEach", new { array = "var.sensors" },
                ("pub", "publish", new { topic = "plant/{{payload}}/temp", payload = "{{index}}" }))
            .Var("sensors", "[\"k1\",\"k2\",3]");

        var outcome = Activate(chart.Compile());

        Assert.Equal(["plant/k1/temp", "plant/k2/temp", "plant/3/temp"], Topics(outcome));
        Assert.Equal(["1", "2", "3"], outcome.Publishes.Select(Text));
    }

    [Fact]
    public void After_its_loop_a_run_carries_the_message_it_went_in_with()
    {
        var chart = new ChartBuilder()
            .Node("start", "start").Node("read", "mqttIn", new { filter = "plant/list" })
            .Node("loop", "forEach", new { array = "$.ids" }).Node("say", "debug")
            .Node("echo", "publish", new { topic = "echo/{{topic[1]}}", payload = "{{payload}}" }).Node("end", "end")
            .Then("start", "read", "loop").Wire("loop", "body", "say").Wire("say", "out", "loop", "next")
            .Wire("loop", "done", "echo").Then("echo", "end");
        Activate(chart.Compile());

        var outcome = _runtime.OnMessage(Msg("plant/list", "{\"ids\":[\"a\",\"b\"]}"), T0);

        Assert.Equal(["a", "b"], outcome.Debug.Select(line => line.Text));
        var echo = Assert.Single(outcome.Publishes);
        Assert.Equal("echo/list", echo.Request.Topic);
        Assert.Equal("{\"ids\":[\"a\",\"b\"]}", Text(echo));
    }

    [Fact]
    public void For_each_over_something_that_is_not_an_array_says_so_and_goes_done()
    {
        var outcome = Activate(Body("forEach", new { array = "var.sensors" }, ("say", "debug", null)).Var("sensors", "k1").Compile());

        Assert.Equal(FlowDebugEntry.Error, Assert.Single(outcome.Debug).Kind);
        Assert.Equal(1, Node("loop").Errors);
        Assert.Equal(FlowRunState.Finished, Run().State);
    }

    [Fact]
    public void For_each_walks_at_most_a_thousand_elements()
    {
        var big = "[" + string.Join(',', Enumerable.Range(0, FlowLimits.ForEachElements + 1)) + "]";
        var first = Activate(Body("forEach", new { array = "var.big" }, ("say", "debug", null)).Var("big", big).Compile());

        var printed = first.Debug.Concat(Settle().SelectMany(outcome => outcome.Debug))
            .Count(line => line.Kind == FlowDebugEntry.Message);

        Assert.Equal(FlowLimits.ForEachElements, printed);
        Assert.Equal(1, Node("loop").Errors);
    }

    [Fact]
    public void A_run_takes_a_thousand_steps_a_turn_and_the_rest_on_the_next()
    {
        var first = Activate(Body("for", new { times = "1000" }, ("say", "debug", null)).Compile());

        Assert.Equal(FlowRunState.Running, Run().State);
        Assert.Equal(DateTimeOffset.MinValue, _runtime.NextDue);
        Assert.True(first.Debug.Count < 1_000);

        var rest = Settle();

        Assert.Equal(1_000, first.Debug.Count + rest.Sum(outcome => outcome.Debug.Count));
        Assert.Equal(FlowRunState.Finished, Run().State);
    }

    // ---- reading messages ----

    [Fact]
    public void Mqtt_in_waits_for_the_next_message_and_goes_on_with_it()
    {
        var chart = Line(
            ("read", "mqttIn", new { filter = "plant/+/temp" }),
            ("pub", "publish", new { topic = "out/{{topic[1]}}", payload = "{{$.temp}}" }));

        Assert.Empty(Activate(chart.Compile()).Publishes);
        Assert.Equal(FlowRunState.Waiting, Run().State);
        Assert.Equal(new FlowWaiting(null, "plant/+/temp"), Run().Waiting);
        Assert.Equal(["plant/+/temp"], _runtime.Filters());

        var publish = Assert.Single(_runtime.OnMessage(Msg("plant/k1/temp", "{\"temp\":94.2}"), T0).Publishes);

        Assert.Equal("out/k1", publish.Request.Topic);
        Assert.Equal("94.2", Text(publish));
        Assert.Equal(FlowRunState.Finished, Run().State);
        Assert.Empty(_runtime.Filters());
    }

    [Fact]
    public void Messages_that_come_before_the_read_wait_in_its_queue()
    {
        var chart = Line(("pause", "wait", new { seconds = "1" }), ("read", "mqttIn", new { filter = "a/#" }), ("say", "debug", null));
        Activate(chart.Compile());

        Assert.Empty(_runtime.OnMessage(Msg("a/1", "first"), T0).Debug);
        _runtime.OnMessage(Msg("a/2", "second"), T0);

        Assert.Equal("first", Assert.Single(_runtime.OnTick(T0.AddSeconds(1), connected: true).Debug).Text);
    }

    [Fact]
    public void A_monitor_is_a_forever_loop_round_a_read()
    {
        Activate(Body("for", new { forever = true }, ("read", "mqttIn", new { filter = "plant/+/temp" }), ("say", "debug", null)).Compile());

        Assert.Equal("1", Assert.Single(_runtime.OnMessage(Msg("plant/k1/temp", "1"), T0).Debug).Text);
        Assert.Equal("2", Assert.Single(_runtime.OnMessage(Msg("plant/k2/temp", "2"), T0).Debug).Text);
        Assert.Equal(FlowRunState.Waiting, Run().State);
    }

    [Fact]
    public void A_value_replayed_on_subscribe_is_read_only_by_a_node_that_asks_for_it()
    {
        var plain = Line(("read", "mqttIn", new { filter = "a/b" }), ("say", "debug", null));
        Activate(plain.Compile());

        Assert.Empty(_runtime.OnMessage(Msg("a/b", "old", replay: true), T0).Debug);
        Assert.Equal("new", Assert.Single(_runtime.OnMessage(Msg("a/b", "new"), T0).Debug).Text);

        var replaying = new ChartBuilder("f2").Node("start", "start").Node("read", "mqttIn", new { filter = "a/b", replay = true })
            .Node("say", "debug").Node("end", "end").Then("start", "read", "say", "end");
        Activate(replaying.Compile());

        Assert.Equal("old", Assert.Single(_runtime.OnMessage(Msg("a/b", "old", replay: true), T0).Debug).Text);
    }

    [Fact]
    public void A_run_does_not_read_what_it_has_just_published()
    {
        Activate(Line(
            ("pub", "publish", new { topic = "loop/x", payload = "1" }),
            ("read", "mqttIn", new { filter = "loop/x" }),
            ("say", "debug", null)).Compile());

        Assert.Empty(_runtime.OnMessage(Msg("loop/x", "1"), T0).Debug);
        Assert.Equal(1, Node("read").Outs["echo"]);
        Assert.Equal("2", Assert.Single(_runtime.OnMessage(Msg("loop/x", "2"), T0).Debug).Text);
    }

    [Fact]
    public void A_full_queue_lets_its_oldest_go()
    {
        Activate(Line(("pause", "wait", new { seconds = "1" }), ("read", "mqttIn", new { filter = "a/b" }), ("say", "debug", null)).Compile());

        for (var i = 0; i <= FlowLimits.QueuedMessages; i++) _runtime.OnMessage(Msg("a/b", $"{i}"), T0);

        Assert.Equal(1, Node("read").Outs["dropped"]);
        Assert.Equal("1", Assert.Single(_runtime.OnTick(T0.AddSeconds(1), connected: true).Debug).Text);
    }

    // ---- variables ----

    [Fact]
    public void Set_gives_a_variable_a_value_the_rest_of_the_run_reads()
    {
        var chart = new ChartBuilder().Var("limit", "90")
            .Node("start", "start").Node("cfg", "mqttIn", new { filter = "cfg/limit" })
            .Node("keep", "set", new { variable = "limit", value = "{{payload}}" })
            .Node("read", "mqttIn", new { filter = "plant/temp" })
            .Node("test", "if", new { field = "", test = "gt", value = "{{var.limit}}" })
            .Node("hot", "publish", new { topic = "hot", payload = "{{payload}} over {{var.limit}}" }).Node("end", "end")
            .Then("start", "cfg", "keep", "read", "test").Wire("test", "yes", "hot").Wire("test", "no", "end").Then("hot", "end");
        Activate(chart.Compile());

        Assert.Equal("90", Run().Variables["limit"]);
        _runtime.OnMessage(Msg("cfg/limit", "50"), T0);
        Assert.Equal("50", Run().Variables["limit"]);

        Assert.Equal("60 over 50", Text(Assert.Single(_runtime.OnMessage(Msg("plant/temp", "60"), T0).Publishes)));
    }

    private static ChartBuilder Remembers(string name = "Boiler watch") => new ChartBuilder("f1", name).Var("n", "start")
        .Node("start", "start").Node("read", "mqttIn", new { filter = "x/y" })
        .Node("keep", "set", new { variable = "n", value = "{{payload}}" })
        .Node("again", "mqttIn", new { filter = "x/z" }).Node("end", "end")
        .Then("start", "read", "keep", "again", "end");

    [Fact]
    public void An_unchanged_flow_deployed_again_keeps_its_run()
    {
        Activate(Remembers().Compile());
        _runtime.OnMessage(Msg("x/y", "seen"), T0);

        Activate(Remembers().Compile());

        Assert.Equal("seen", Run().Variables["n"]);
        Assert.Equal("again", Run().At);
    }

    [Fact]
    public void A_changed_flow_starts_again_from_start_with_its_declared_values()
    {
        Activate(Remembers().Compile());
        _runtime.OnMessage(Msg("x/y", "seen"), T0);

        Activate(Remembers("Renamed").Compile());

        Assert.Equal("start", Run().Variables["n"]);
        Assert.Equal("read", Run().At);
    }

    [Fact]
    public void A_value_over_64_KB_leaves_a_variable_as_it_was()
    {
        // Taken past the limit by what it fills in, a variable at the limit and one character more: what is
        // written in the box is held to 1,024 characters.
        Activate(Line(("keep", "set", new { variable = "n", value = "{{var.big}}!" }))
            .Var("n", "1").Var("big", new string('x', FlowLimits.VariableBytes)).Compile());

        Assert.Equal("1", Run().Variables["n"]);
        Assert.Equal(1, Node("keep").Errors);
    }

    // ---- decisions and mistakes ----

    [Fact]
    public void An_if_on_a_missing_field_goes_no()
    {
        var chart = new ChartBuilder()
            .Node("start", "start").Node("test", "if", new { field = "$.temp", test = "lt", value = "10" })
            .Node("cold", "publish", new { topic = "cold" }).Node("end", "end")
            .Then("start", "test").Wire("test", "yes", "cold").Wire("test", "no", "end").Then("cold", "end");

        Assert.Empty(Activate(chart.Compile()).Publishes);
        Assert.Equal(1, Node("test").Outs["no"]);
        Assert.Equal("no such field", Node("test").Note);
    }

    [Fact]
    public void An_if_whose_value_is_not_a_number_counts_an_error_and_goes_no()
    {
        var chart = new ChartBuilder().Var("limit", "ninety")
            .Node("start", "start").Node("test", "if", new { field = "", test = "gt", value = "{{var.limit}}" }).Node("end", "end")
            .Then("start", "test").Wire("test", "yes", "end").Wire("test", "no", "end");

        var outcome = Activate(chart.Compile());

        Assert.Equal(1, Node("test").Errors);
        Assert.Contains("ninety", Assert.Single(outcome.Debug).Text);
        Assert.Equal(1, Node("test").Outs["no"]);
    }

    /// <summary>Start → read a/b → an If on the payload with this test and value → End either way.</summary>
    private static ChartBuilder Deciding(string test, string value) => new ChartBuilder()
        .Node("start", "start").Node("read", "mqttIn", new { filter = "a/b" })
        .Node("test", "if", new { field = "", test, value }).Node("end", "end")
        .Then("start", "read", "test").Wire("test", "yes", "end").Wire("test", "no", "end");

    // A value is most often a variable — a list of ids for one of, a pattern — and a variable holds up to
    // 64 KB. Cut at what can be written in the box, a list was judged on its first thousand characters, and
    // an id further on went no with nothing to say why.
    [Fact]
    public void One_of_a_list_longer_than_a_box_can_hold_finds_an_id_at_its_end()
    {
        var list = string.Join(",", Enumerable.Range(0, 400).Select(i => $"x{i:000}")) + ",k9";
        Assert.True(list.Length > 2_000);

        Activate(Deciding("oneOf", "{{var.list}}").Var("list", list).Compile());
        _runtime.OnMessage(Msg("a/b", "k9"), T0);

        Assert.Equal(1, Node("test").Outs["yes"]);
        Assert.Equal(0, Node("test").Errors);
    }

    // Past what a variable can hold, a value is cut, and a cut value is not the value: it is the step that
    // failed, said on the node, and the message goes no, as it does when a number test is given text.
    [Fact]
    public void A_value_that_comes_out_larger_than_64_KB_counts_an_error_and_goes_no()
    {
        var big = new string('x', FlowLimits.VariableBytes);

        Activate(Deciding("eq", "{{var.big}}!").Var("big", big).Compile());
        var outcome = _runtime.OnMessage(Msg("a/b", big + "!"), T0);

        Assert.Equal(1, Node("test").Outs["no"]);
        Assert.Equal(1, Node("test").Errors);
        Assert.Equal("A value came out larger than 64 KB, so this message went no.", Assert.Single(outcome.Debug).Text);
    }

    // '(a+)+$' is the textbook runaway pattern, and the linear engine answered it at once, with a no and not a
    // word about it. A flow's patterns are all on the ordinary engine, which backtracks, so over a text made for
    // it this one runs out of its 50 ms, and that is an error on the node, the sentence that says so, and a no.
    // So does the pattern a rule has to put a lookbehind on to be kept off the linear engine.
    [Theory]
    [InlineData("(a+)+$")]
    [InlineData(HostilePatterns.Catastrophic)]
    public void A_pattern_that_runs_out_of_time_goes_no_and_ends_the_runs_turn(string pattern)
    {
        var chart = new ChartBuilder().Var("text", HostilePatterns.Payload)
            .Node("start", "start").Node("test", "if", new { field = "var.text", test = "matches", value = pattern })
            .Node("say", "debug").Node("end", "end")
            .Then("start", "test").Wire("test", "yes", "end").Wire("test", "no", "say").Then("say", "end");

        var outcome = Activate(chart.Compile());

        Assert.Equal(1, Node("test").Errors);
        Assert.Equal("The pattern took longer than 50 ms, so this message went no.", Assert.Single(outcome.Debug).Text);
        Assert.Equal(FlowRunState.Running, Run().State);
        Assert.DoesNotContain(outcome.Debug, line => line.Kind == FlowDebugEntry.Message);
        Assert.Contains(Settle().SelectMany(next => next.Debug), line => line.NodeId == "say");
    }

    // A flow keeps neither the text nor the pattern small: a variable holds a text of 64 KB or a pattern of ten
    // thousand characters, and a counted loop is as long as its count, so ten characters typed into the node can
    // be as long as that. The ordinary engine starts the match again at each place in the text, and for a
    // pattern that begins with nine thousand 'a's over a text of 64 KB of them it runs to the end of the text and
    // back from each: fifteen seconds for one match with no timeout, twenty for the pattern from a variable, on
    // the pump every flow shares, from a Test that needs no save. It checks its timeout as it steps, so the
    // match ends at the 50 ms, and goes no with the error: a matches step does not hold the pump past that.
    [Theory]
    [InlineData("{{var.pattern}}")]
    [InlineData("a{9000}.*z")]
    public void A_pattern_that_is_slow_over_a_long_text_runs_out_of_time_typed_in_or_read_from_a_variable(string value)
    {
        var chart = new ChartBuilder()
            .Var("text", new string('a', FlowLimits.VariableBytes)).Var("pattern", new string('a', 9_896) + ".*z")
            .Node("start", "start").Node("test", "if", new { field = "var.text", test = "matches", value })
            .Node("say", "debug").Node("end", "end")
            .Then("start", "test").Wire("test", "yes", "end").Wire("test", "no", "say").Then("say", "end");

        var outcome = Activate(chart.Compile());

        Assert.Equal(1, Node("test").Errors);
        Assert.Equal("The pattern took longer than 50 ms, so this message went no.", Assert.Single(outcome.Debug).Text);
        Assert.Equal(FlowRunState.Running, Run().State);
        Assert.Contains(Settle().SelectMany(next => next.Debug), line => line.NodeId == "say");
    }

    [Fact]
    public void A_wait_whose_seconds_are_not_a_number_counts_an_error_and_does_not_wait()
    {
        var outcome = Activate(Line(("pause", "wait", new { seconds = "{{var.delay}}" }), ("pub", "publish", new { topic = "a/b" }))
            .Var("delay", "soon").Compile());

        Assert.Single(outcome.Publishes);
        Assert.Equal(1, Node("pause").Errors);
    }

    [Fact]
    public void A_publish_with_no_link_is_an_error_and_the_run_goes_on()
    {
        _runtime.OnTick(T0, connected: false);

        var outcome = Activate(Line(("pub", "publish", new { topic = "a/b" }), ("say", "debug", null)).Compile());

        Assert.Empty(outcome.Publishes);
        Assert.Equal(1, Node("pub").Errors);
        Assert.Contains(outcome.Debug, line => line.Kind == FlowDebugEntry.Message && line.NodeId == "say");
        Assert.Equal(FlowRunState.Finished, Run().State);
    }

    [Fact]
    public void A_run_publishes_at_most_fifty_a_second()
    {
        var outcome = Activate(Body("for", new { times = "60" }, ("pub", "publish", new { topic = "a/{{index}}" })).Compile());

        Assert.Equal(FlowLimits.PublishesPerSecond, outcome.Publishes.Count);
        Assert.Equal(60 - FlowLimits.PublishesPerSecond, Node("pub").Errors);
    }

    [Fact]
    public void A_step_the_engine_could_not_carry_out_is_counted_on_its_node()
    {
        var publish = Assert.Single(Activate(Line(("pub", "publish", new { topic = "a/b" })).Compile()).Publishes);

        var outcome = _runtime.StepFailed(publish.Run, publish.Serial, publish.NodeId, "The broker said no.", T0);

        Assert.Equal(1, Node("pub").Errors);
        Assert.Equal("The broker said no.", Assert.Single(outcome.Debug).Text);
    }

    // A Webhook node counts its post as posted when it asks for it, before the engine has handed it on. One
    // the engine could not hand on at all was never posted, so the engine says what to take back with the
    // failure; one it handed on and that failed later was posted, and keeps the count beside its error.
    [Fact]
    public void A_post_the_engine_never_handed_on_is_taken_back_off_posted()
    {
        var post = Assert.Single(Activate(Line(("hook", "webhook", new { url = "https://hooks.example.com/x" })).Compile()).Webhooks);
        Assert.Equal(1, Node("hook").Outs["posted"]);

        _runtime.StepFailed(post.Run, post.Serial, post.NodeId, "Too many webhook posts were waiting; this one was dropped.", T0,
            takeBack: "posted");

        Assert.Equal(0, Node("hook").Outs.GetValueOrDefault("posted"));
        Assert.Equal(1, Node("hook").Errors);
    }

    [Fact]
    public void A_post_that_failed_after_it_was_handed_on_stays_posted()
    {
        var post = Assert.Single(Activate(Line(("hook", "webhook", new { url = "https://hooks.example.com/x" })).Compile()).Webhooks);

        _runtime.StepFailed(post.Run, post.Serial, post.NodeId, "The webhook was not delivered after 3 attempts: the receiver answered 500.", T0);

        Assert.Equal(1, Node("hook").Outs["posted"]);
        Assert.Equal(1, Node("hook").Errors);
    }

    // A publish fails in the engine's own loop, and a webhook post is given up on by its channel, a while
    // after the turn that asked for them. By then an Update or a new Test can have put another run where
    // the one that asked was, and what comes back is the asking run's alone.

    /// <summary>Start → a publish → a webhook post to <paramref name="url"/> → a read that waits → End.</summary>
    private static ChartBuilder Asks(string url = "https://hooks.example.com/x") => Line(
        ("pub", "publish", new { topic = "a/b" }),
        ("hook", "webhook", new { url }),
        ("read", "mqttIn", new { filter = "a/ack" }));

    /// <summary>Gives up on the publish and the post a call asked for, as the engine would, and what came of each.</summary>
    private FlowOutcome[] Failed(FlowOutcome asked)
    {
        var publish = Assert.Single(asked.Publishes);
        var post = Assert.Single(asked.Webhooks);

        return
        [
            _runtime.StepFailed(publish.Run, publish.Serial, publish.NodeId, "The broker said no.", T0),
            _runtime.StepFailed(post.Run, post.Serial, post.NodeId, "The endpoint answered 404.", T0),
        ];
    }

    // Pressed again with the address put right: the first test's post fails once the second is in its place.
    [Fact]
    public void A_failure_that_comes_back_after_its_test_was_replaced_is_not_counted_on_the_test_in_its_place()
    {
        var first = _runtime.StartTest(Asks("https://hooks.example.com/typo").Compile(), T0);
        _runtime.StartTest(Asks().Compile(), T0);

        Assert.All(Failed(first), outcome => Assert.True(outcome.IsEmpty));
        Assert.Equal(0, Node("pub", FlowRunKind.Test).Errors);
        Assert.Equal(0, Node("hook", FlowRunKind.Test).Errors);
    }

    [Fact]
    public void A_failure_that_comes_back_after_an_update_is_not_counted_on_the_updated_run()
    {
        var first = Activate(Asks("https://hooks.example.com/typo").Compile());
        Activate(Asks().Compile());

        Assert.All(Failed(first), outcome => Assert.True(outcome.IsEmpty));
        Assert.Equal(0, Node("pub").Errors);
        Assert.Equal(0, Node("hook").Errors);
    }

    // The other side of the two above: a deploy that changed nothing keeps the run, and with it whatever
    // comes back for it.
    [Fact]
    public void A_failure_that_comes_back_after_a_deploy_that_changed_nothing_is_counted_on_the_run_it_kept()
    {
        var first = Activate(Asks().Compile());
        Activate(Asks().Compile());

        Assert.All(Failed(first), outcome => Assert.False(outcome.IsEmpty));
        Assert.Equal(1, Node("pub").Errors);
        Assert.Equal(1, Node("hook").Errors);
    }

    [Fact]
    public void A_refused_filter_is_marked_on_the_reads_that_asked_for_it()
    {
        Activate(Line(("read", "mqttIn", new { filter = "a/#" })).Compile());

        _runtime.MarkRefused(["a/#"]);

        Assert.Equal(1, Node("read").Errors);
        Assert.Equal("The broker refused this filter.", Node("read").Note);
    }

    // ---- alarms ----

    [Fact]
    public void A_hot_reading_raises_once_and_the_raised_way_runs_once()
    {
        Activate(Watch().Compile());

        var first = _runtime.OnMessage(Msg("plant/k1/temp", "{\"temp\":94.2}"), T0);

        var alarm = Assert.Single(first.Alarms);
        Assert.True(alarm.Raised);
        Assert.Equal("flow-f1-hot", alarm.Alert.RuleId);
        Assert.Equal("k1 at 94.2", alarm.Alert.Reason);
        Assert.Equal(94.2, alarm.Alert.Value);
        Assert.Equal(["plant/k1/cmd"], Topics(first));

        var again = _runtime.OnMessage(Msg("plant/k1/temp", "{\"temp\":95}"), T0);

        Assert.Empty(again.Alarms);
        Assert.Empty(again.Publishes);
        Assert.Equal(1, Node("hot").Outs["up"]);
        Assert.Equal("plant/k1/temp", Assert.Single(Node("hot").Standing).Topic);
    }

    [Fact]
    public void A_cool_reading_clears_the_alarm_of_its_topic()
    {
        Activate(Watch().Compile());
        _runtime.OnMessage(Msg("plant/k1/temp", "{\"temp\":94}"), T0);
        _runtime.OnMessage(Msg("plant/k2/temp", "{\"temp\":94}"), T0);

        var cleared = Assert.Single(_runtime.OnMessage(Msg("plant/k1/temp", "{\"temp\":80}"), T0).Alarms);

        Assert.False(cleared.Raised);
        Assert.Equal("clear", cleared.Alert.ResolvedBy);
        Assert.Equal(["plant/k2/temp"], _runtime.Alarms().Active.Select(alert => alert.Topic));

        Assert.Empty(_runtime.OnMessage(Msg("plant/k1/temp", "{\"temp\":80}"), T0).Alarms);
        Assert.Equal(1, Node("cool").Outs["none"]);
    }

    [Fact]
    public void A_test_runs_beside_the_active_run_with_alarms_of_its_own()
    {
        Activate(Watch().Compile());
        _runtime.OnMessage(Msg("plant/k1/temp", "{\"temp\":94}"), T0);

        _runtime.StartTest(Watch().Compile(), T0);
        var both = _runtime.OnMessage(Msg("plant/k1/temp", "{\"temp\":96}"), T0);

        var test = Assert.Single(both.Alarms);
        Assert.Equal("flowtest-f1-hot", test.Alert.RuleId);
        Assert.Equal(2, _runtime.Alarms().Active.Count);
        Assert.Equal(["f1"], _runtime.Testing());
        Assert.Equal(FlowRunState.Waiting, Run(FlowRunKind.Test).State);
    }

    [Fact]
    public void Stopping_a_test_ends_its_alarms_and_leaves_the_active_ones()
    {
        Activate(Watch().Compile());
        _runtime.StartTest(Watch().Compile(), T0);
        _runtime.OnMessage(Msg("plant/k1/temp", "{\"temp\":94}"), T0);

        var stopped = _runtime.StopTest("f1", remove: false, T0);

        Assert.Equal("test ended", Assert.Single(stopped.Alarms).Alert.ResolvedBy);
        Assert.Equal("flow-f1-hot", Assert.Single(_runtime.Alarms().Active).RuleId);
        Assert.Empty(_runtime.Testing());
        Assert.Equal(FlowRunState.Stopped, Run(FlowRunKind.Test).State);
        Assert.True(_runtime.StopTest("f1", remove: false, T0).IsEmpty);
    }

    /// <summary>A test that reads a/b, then waits five seconds, for ever: one that only Stop ends.</summary>
    private static CompiledFlow Paced() =>
        Body("for", new { forever = true }, ("read", "mqttIn", new { filter = "a/b" }), ("pause", "wait", new { seconds = "5" })).Compile();

    // Stop is how a forever test ends, and what it read and did on the way is what Test was pressed to see. So
    // the run is kept where it was, with every node's counters, as a run that has stopped: with no fault, since
    // nothing went wrong, and nothing left of what a live run holds — no wait to wake from, no filter at the
    // broker, nothing queued for it, and no message it would read.
    [Fact]
    public void A_stopped_test_keeps_where_it_was_and_what_it_counted_and_gives_back_what_it_held()
    {
        _runtime.StartTest(Paced(), T0);
        _runtime.OnMessage(Msg("a/b", "1"), T0);
        Assert.Equal(["a/b"], _runtime.Filters());
        Assert.Equal(T0.AddSeconds(5), _runtime.NextDue);

        var outcome = _runtime.StopTest("f1", remove: false, T0.AddSeconds(1));

        var run = Run(FlowRunKind.Test);
        Assert.Equal(FlowRunState.Stopped, run.State);
        Assert.Equal("pause", run.At);
        Assert.Null(run.Waiting);
        Assert.Null(run.Fault);
        Assert.Equal(1, Node("read", FlowRunKind.Test).Outs["out"]);
        Assert.Equal(1, Node("pause", FlowRunKind.Test).Count);
        Assert.All(run.Nodes, node => Assert.Equal(0, node.Errors));
        Assert.Empty(outcome.Debug);

        Assert.Empty(_runtime.Testing());
        Assert.Empty(_runtime.Filters());
        Assert.Null(_runtime.NextDue);

        // A message to the filter it had finds nobody, and the clock past its wait moves nothing.
        var version = _runtime.Version;
        Assert.True(_runtime.OnMessage(Msg("a/b", "2"), T0.AddSeconds(2)).IsEmpty);
        Assert.True(_runtime.OnTick(T0.AddSeconds(10), connected: true).IsEmpty);
        Assert.Equal(version, _runtime.Version);
        Assert.Equal(1, Node("read", FlowRunKind.Test).Outs["out"]);
        Assert.False(Node("pause", FlowRunKind.Test).Outs.ContainsKey("out"));
    }

    // A stop that removes — what deleting the flow posts — takes the test away whether it is going or not.
    [Fact]
    public void A_stop_that_removes_takes_a_test_that_is_going_away_with_its_alarms()
    {
        _runtime.StartTest(Watch().Compile(), T0);
        _runtime.OnMessage(Msg("plant/k1/temp", "{\"temp\":94}"), T0);

        var removed = _runtime.StopTest("f1", remove: true, T0);

        Assert.Equal("test ended", Assert.Single(removed.Alarms).Alert.ResolvedBy);
        Assert.Empty(_runtime.Alarms().Active);
        Assert.Empty(_runtime.Testing());
        Assert.Empty(_runtime.Filters());
        Assert.DoesNotContain(_runtime.Status().Runs, one => one.Kind == FlowRunKind.Test);
    }

    // The active run's alarms and its test's are kept apart both ways: the test's clear closes none of the
    // active run's (above), and the active run's clear closes none of the test's.
    [Fact]
    public void The_active_runs_clear_does_not_clear_a_tests_alarm()
    {
        Activate(Watch(limit: "95").Compile());
        _runtime.StartTest(Watch(limit: "90").Compile(), T0);

        var reading = _runtime.OnMessage(Msg("plant/k1/temp", "{\"temp\":94}"), T0);

        Assert.Equal("flowtest-f1-hot", Assert.Single(reading.Alarms).Alert.RuleId);
        Assert.Equal(1, Node("cool").Outs["none"]);
        Assert.Equal("flowtest-f1-hot", Assert.Single(_runtime.Alarms().Active).RuleId);
    }

    [Fact]
    public void A_test_that_reaches_an_end_ends_its_alarms_and_stays_to_be_read()
    {
        var chart = new ChartBuilder()
            .Node("start", "start").Node("hot", "alarmRaise", new { name = "Hot", level = "warn" }).Node("end", "end")
            .Then("start", "hot").Wire("hot", "raised", "end").Wire("hot", "up", "end");

        var outcome = _runtime.StartTest(chart.Compile(), T0);

        Assert.Equal([true, false], outcome.Alarms.Select(alarm => alarm.Raised));
        Assert.Equal("test ended", outcome.Alarms[1].Alert.ResolvedBy);
        Assert.Equal(FlowRunState.Finished, Run(FlowRunKind.Test).State);
        Assert.Empty(_runtime.Testing());
    }

    [Fact]
    public void A_new_test_takes_the_place_of_the_one_still_going()
    {
        var waiting = Line(("read", "mqttIn", new { filter = "a/b" })).Compile();

        _runtime.StartTest(waiting, T0);
        _runtime.StartTest(waiting, T0.AddSeconds(1));

        Assert.Single(_runtime.Status().Runs, run => run.Kind == FlowRunKind.Test);
    }

    [Fact]
    public void Deactivating_ends_the_active_alarms_flow_off_and_deleting_flow_removed()
    {
        Activate(Watch().Compile());
        _runtime.OnMessage(Msg("plant/k1/temp", "{\"temp\":94}"), T0);

        var off = _runtime.Deploy([Watch().Off().Compile()], ["f1"], T0);

        Assert.Equal("flow off", Assert.Single(off.Alarms).Alert.ResolvedBy);
        Assert.Empty(_runtime.Status().Runs);

        Activate(Watch().Compile());
        _runtime.OnMessage(Msg("plant/k1/temp", "{\"temp\":94}"), T0);

        Assert.Equal("flow removed", Assert.Single(_runtime.Deploy([], [], T0).Alarms).Alert.ResolvedBy);
    }

    [Fact]
    public void An_update_keeps_an_alarm_whose_raise_did_not_change_and_ends_one_that_did()
    {
        Activate(Watch().Compile());
        _runtime.OnMessage(Msg("plant/k1/temp", "{\"temp\":94}"), T0);

        Assert.Empty(Activate(Watch(limit: "92").Compile()).Alarms);
        Assert.Single(_runtime.Alarms().Active);

        Assert.Equal("flow changed", Assert.Single(Activate(Watch(limit: "92", level: "warn").Compile()).Alarms).Alert.ResolvedBy);
    }

    [Fact]
    public void A_link_that_drops_ends_every_alarm()
    {
        Activate(Watch().Compile());
        _runtime.OnMessage(Msg("plant/k1/temp", "{\"temp\":94}"), T0);

        var dropped = _runtime.OnTick(T0.AddSeconds(1), connected: false);

        Assert.Equal("connection ended", Assert.Single(dropped.Alarms).Alert.ResolvedBy);
    }

    // ---- channels ----

    [Fact]
    public void Sound_notify_and_webhook_do_their_job_once_a_second()
    {
        var chart = Body("for", new { times = "2" },
                ("beep", "sound", new { level = "critical" }),
                ("tell", "notify", new { text = "{{var.site}} is hot", level = "warn" }),
                ("hook", "webhook", new { url = "https://hooks.example.com/x", body = "{\"site\":\"{{var.site}}\"}" }))
            .Var("site", "north");

        var outcome = Activate(chart.Compile());

        Assert.Equal(AlertSeverity.Critical, Assert.Single(outcome.Sounds).Level);

        var notice = Assert.Single(outcome.Notices);
        Assert.Equal("north is hot", notice.Text);
        Assert.Equal("Boiler watch", notice.FlowName);
        Assert.Equal(AlertSeverity.Warn, notice.Level);

        var post = Assert.Single(outcome.Webhooks);
        Assert.Equal("https://hooks.example.com/x", post.Url);
        Assert.Equal("{\"site\":\"north\"}", post.Body);
        Assert.Equal("application/json", post.ContentType);

        Assert.Equal(1, Node("beep").Outs["dropped"]);
        Assert.Equal(1, Node("tell").Outs["dropped"]);
        Assert.Equal(1, Node("hook").Outs["dropped"]);
    }

    [Fact]
    public void A_body_that_is_not_json_goes_as_text() =>
        Assert.Equal("text/plain", Assert.Single(Activate(Line(("hook", "webhook", new { url = "https://hooks.example.com/x", body = "hot" })).Compile()).Webhooks).ContentType);

    [Fact]
    public void A_channel_does_its_job_again_a_second_later()
    {
        var chart = Body("for", new { times = "2" }, ("beep", "sound", new { level = "info" }), ("pause", "wait", new { seconds = "1" }));

        Assert.Single(Activate(chart.Compile()).Sounds);
        Assert.Single(_runtime.OnTick(T0.AddSeconds(1), connected: true).Sounds);
    }

    [Fact]
    public void What_a_test_says_is_marked_as_a_tests()
    {
        var outcome = _runtime.StartTest(Line(("beep", "sound", new { level = "info" }), ("tell", "notify", new { text = "hi", level = "info" }), ("say", "debug", null)).Compile(), T0);

        Assert.True(Assert.Single(outcome.Sounds).Test);
        Assert.True(Assert.Single(outcome.Notices).Test);
        Assert.True(Assert.Single(outcome.Debug).Test);
    }

    // ---- the clock ----

    [Fact]
    public void Next_due_is_the_earliest_wait()
    {
        Activate(Line(("pause", "wait", new { seconds = "5" })).Compile());

        Assert.Equal(T0.AddSeconds(5), _runtime.NextDue);
    }

    [Fact]
    public void A_wait_ends_at_once_when_the_clock_is_set_back_past_it()
    {
        Activate(Line(("pause", "wait", new { seconds = "10" }), ("pub", "publish", new { topic = "a/b" })).Compile());

        Assert.Single(_runtime.OnTick(T0.AddHours(-1), connected: true).Publishes);
    }

    // ---- loops inside loops, and the ways out of them ----

    [Fact]
    public void A_loop_in_a_loop_runs_afresh_at_every_turn_of_the_outer_one()
    {
        // The inner turns carry their own index and element, and the inner loop's done hands back the
        // message of the outer turn it was entered in.
        var chart = new ChartBuilder().Var("keys", "[\"a\",\"b\"]")
            .Node("start", "start").Node("outer", "for", new { times = "2" }).Node("inner", "forEach", new { array = "var.keys" })
            .Node("each", "publish", new { topic = "{{payload}}/{{index}}" })
            .Node("after", "publish", new { topic = "outer/{{index}}" }).Node("end", "end")
            .Then("start", "outer").Wire("outer", "body", "inner")
            .Wire("inner", "body", "each").Wire("each", "out", "inner", "next")
            .Wire("inner", "done", "after").Wire("after", "out", "outer", "next")
            .Wire("outer", "done", "end");

        Assert.Equal(["a/1", "b/2", "outer/1", "a/1", "b/2", "outer/2"], Topics(Activate(chart.Compile())));
        Assert.Equal(FlowRunState.Finished, Run().State);
    }

    [Fact]
    public void A_body_that_leaves_its_loop_for_an_end_ends_the_run_there()
    {
        var chart = new ChartBuilder().Var("keys", "[\"a\",\"b\",\"c\"]")
            .Node("start", "start").Node("loop", "forEach", new { array = "var.keys" })
            .Node("test", "if", new { field = "", test = "eq", value = "b" })
            .Node("pub", "publish", new { topic = "seen/{{payload}}" }).Node("stop", "end").Node("end", "end")
            .Then("start", "loop").Wire("loop", "body", "test")
            .Wire("test", "yes", "stop").Wire("test", "no", "pub").Wire("pub", "out", "loop", "next")
            .Wire("loop", "done", "end");

        Assert.Equal(["seen/a"], Topics(Activate(chart.Compile())));
        Assert.Equal(FlowRunState.Finished, Run().State);
        Assert.Equal("stop", Run().At);
    }

    [Fact]
    public void A_break_out_of_two_loops_goes_on_with_the_message_of_the_turn_it_left()
    {
        var chart = new ChartBuilder().Var("keys", "[\"a\",\"b\",\"c\"]")
            .Node("start", "start").Node("outer", "for", new { times = "5" }).Node("inner", "forEach", new { array = "var.keys" })
            .Node("test", "if", new { field = "", test = "eq", value = "b" })
            .Node("found", "publish", new { topic = "found/{{payload}}/{{index}}" }).Node("end", "end")
            .Then("start", "outer").Wire("outer", "body", "inner")
            .Wire("inner", "body", "test").Wire("test", "no", "inner", "next").Wire("test", "yes", "found")
            .Wire("inner", "done", "outer", "next")
            .Wire("outer", "done", "end").Then("found", "end");

        Assert.Equal(["found/b/2"], Topics(Activate(chart.Compile())));
        Assert.Equal(FlowRunState.Finished, Run().State);
    }

    [Fact]
    public void A_loop_left_by_a_break_starts_afresh_when_it_is_entered_again()
    {
        // The inner loop goes on to the outer one's next at its second element, every time. Were what it
        // left behind read as a turn, the outer loop's second turn would not begin at a.
        var chart = new ChartBuilder().Var("keys", "[\"a\",\"b\",\"c\"]")
            .Node("start", "start").Node("outer", "for", new { times = "2" }).Node("inner", "forEach", new { array = "var.keys" })
            .Node("test", "if", new { field = "", test = "eq", value = "b" }).Node("say", "debug").Node("end", "end")
            .Then("start", "outer").Wire("outer", "body", "inner")
            .Wire("inner", "body", "test").Wire("test", "no", "say").Wire("say", "out", "inner", "next")
            .Wire("test", "yes", "outer", "next").Wire("inner", "done", "outer", "next")
            .Wire("outer", "done", "end");

        Assert.Equal(["a", "a"], Activate(chart.Compile()).Debug.Select(line => line.Text));
        Assert.Equal(FlowRunState.Finished, Run().State);
    }

    [Fact]
    public void For_whose_times_are_not_a_number_counts_an_error_and_goes_done()
    {
        var outcome = Activate(Body("for", new { times = "{{var.n}}" }, ("pub", "publish", new { topic = "a/b" })).Var("n", "lots").Compile());

        Assert.Empty(outcome.Publishes);
        Assert.Equal(1, Node("loop").Errors);
        Assert.Equal(FlowRunState.Finished, Run().State);
    }

    [Fact]
    public void A_forever_turn_whose_only_wait_is_in_a_for_each_over_nothing_stops_the_run()
    {
        // It compiles, since its turn holds a Wait, and its first turn comes round without waiting.
        var chart = new ChartBuilder().Var("list", "[]")
            .Node("start", "start").Node("loop", "for", new { forever = true }).Node("each", "forEach", new { array = "var.list" })
            .Node("pause", "wait", new { seconds = "1" }).Node("end", "end")
            .Then("start", "loop").Wire("loop", "body", "each")
            .Wire("each", "body", "pause").Wire("pause", "out", "each", "next")
            .Wire("each", "done", "loop", "next").Wire("loop", "done", "end");

        Activate(chart.Compile());

        Assert.Equal(FlowRunState.Stopped, Run().State);
        Assert.Equal(1, Node("loop").Errors);
        Assert.Null(_runtime.NextDue);
    }

    [Fact]
    public void A_forever_loop_that_waited_on_one_turn_and_not_on_the_next_is_stopped_at_the_next()
    {
        // The guard measures each turn, and not the loop since it was entered: the If sends the first turn
        // through the Wait and the second one round it.
        var chart = new ChartBuilder().Var("waited", "no")
            .Node("start", "start").Node("loop", "for", new { forever = true })
            .Node("test", "if", new { field = "var.waited", test = "eq", value = "yes" })
            .Node("keep", "set", new { variable = "waited", value = "yes" })
            .Node("pause", "wait", new { seconds = "1" }).Node("say", "debug").Node("end", "end")
            .Then("start", "loop").Wire("loop", "body", "test")
            .Wire("test", "no", "keep").Then("keep", "pause").Wire("pause", "out", "loop", "next")
            .Wire("test", "yes", "say").Wire("say", "out", "loop", "next")
            .Wire("loop", "done", "end");
        Activate(chart.Compile());

        var second = _runtime.OnTick(T0.AddSeconds(1), connected: true);

        Assert.Equal(FlowRunState.Stopped, Run().State);
        Assert.Single(second.Debug, line => line.Kind == FlowDebugEntry.Message);
    }

    // ---- a turn, and the clock ----

    [Fact]
    public void A_node_a_run_waited_at_is_entered_once()
    {
        Activate(Line(("pause", "wait", new { seconds = "1" }), ("read", "mqttIn", new { filter = "a/b" })).Compile());

        _runtime.OnTick(T0.AddSeconds(1), connected: true);
        _runtime.OnMessage(Msg("a/b", "1"), T0.AddSeconds(1));

        Assert.Equal(1, Node("pause").Count);
        Assert.Equal(1, Node("read").Count);
        Assert.Equal(FlowRunState.Finished, Run().State);
    }

    [Fact]
    public void A_turn_is_a_thousand_steps_and_no_more()
    {
        // An empty body makes every turn one step, the loop coming back to its own next, so a thousand
        // steps are Start and 999 entries of the loop.
        Activate(Body("for", new { times = "5000" }).Compile());

        Assert.Equal(FlowLimits.StepsPerTurn - 1, Node("loop").Count);
    }

    [Fact]
    public void Next_due_is_the_earliest_wait_of_every_run()
    {
        var sooner = new ChartBuilder("f2").Node("start", "start").Node("pause", "wait", new { seconds = "3" }).Node("end", "end")
            .Then("start", "pause", "end").Compile();

        _runtime.Deploy([Line(("pause", "wait", new { seconds = "5" })).Compile(), sooner], ["f1", "f2"], T0);

        Assert.Equal(T0.AddSeconds(3), _runtime.NextDue);
    }

    [Fact]
    public void A_run_publishes_again_once_its_second_is_up()
    {
        var chart = new ChartBuilder()
            .Node("start", "start").Node("outer", "for", new { times = "2" }).Node("burst", "for", new { times = "60" })
            .Node("pub", "publish", new { topic = "a/{{index}}" }).Node("pause", "wait", new { seconds = "1" }).Node("end", "end")
            .Then("start", "outer").Wire("outer", "body", "burst").Wire("burst", "body", "pub").Wire("pub", "out", "burst", "next")
            .Wire("burst", "done", "pause").Wire("pause", "out", "outer", "next").Wire("outer", "done", "end");

        Assert.Equal(FlowLimits.PublishesPerSecond, Activate(chart.Compile()).Publishes.Count);
        Assert.Equal(FlowLimits.PublishesPerSecond, _runtime.OnTick(T0.AddSeconds(1), connected: true).Publishes.Count);
    }

    [Fact]
    public void A_run_publishes_at_its_rate_a_second_after_the_clock_is_set_back()
    {
        // Fifty a turn and a Wait of a second: the bucket is empty when the clock goes back an hour, and
        // the turn after that must find it refilled by the second it waited, not by the hour to come.
        var chart = new ChartBuilder()
            .Node("start", "start").Node("loop", "for", new { forever = true }).Node("burst", "for", new { times = "50" })
            .Node("pub", "publish", new { topic = "a/{{index}}" }).Node("pause", "wait", new { seconds = "1" }).Node("end", "end")
            .Then("start", "loop").Wire("loop", "body", "burst").Wire("burst", "body", "pub").Wire("pub", "out", "burst", "next")
            .Wire("burst", "done", "pause").Wire("pause", "out", "loop", "next").Wire("loop", "done", "end");
        Assert.Equal(FlowLimits.PublishesPerSecond, Activate(chart.Compile()).Publishes.Count);

        var back = T0.AddHours(-1);
        _runtime.OnTick(back, connected: true);

        Assert.Equal(FlowLimits.PublishesPerSecond, _runtime.OnTick(back.AddSeconds(1), connected: true).Publishes.Count);
    }

    [Fact]
    public void A_channel_does_its_job_again_after_the_clock_is_set_back()
    {
        var chart = Body("for", new { times = "2" }, ("beep", "sound", new { level = "info" }), ("pause", "wait", new { seconds = "1" }));

        Assert.Single(Activate(chart.Compile()).Sounds);
        Assert.Single(_runtime.OnTick(T0.AddHours(-1), connected: true).Sounds);
    }

    [Fact]
    public void A_move_to_another_broker_ends_every_alarm_and_runs_nothing_that_is_due()
    {
        var waiting = new ChartBuilder("f2").Node("start", "start").Node("pause", "wait", new { seconds = "1" })
            .Node("pub", "publish", new { topic = "a/b" }).Node("end", "end").Then("start", "pause", "pub", "end").Compile();
        _runtime.Deploy([Watch().Compile(), waiting], ["f1", "f2"], T0);
        _runtime.OnMessage(Msg("plant/k1/temp", "{\"temp\":94}"), T0);

        var moved = _runtime.OnMove(T0.AddSeconds(2));

        Assert.Equal("connection ended", Assert.Single(moved.Alarms).Alert.ResolvedBy);
        Assert.Empty(moved.Publishes);
        Assert.Equal(FlowRunState.Waiting, Run(flowId: "f2").State);
        Assert.Single(_runtime.OnTick(T0.AddSeconds(2), connected: true).Publishes);
    }

    [Fact]
    public void Every_change_moves_the_version()
    {
        Activate(Line(("pause", "wait", new { seconds = "1" }), ("read", "mqttIn", new { filter = "a/b" })).Compile());

        var before = _runtime.Version;
        _runtime.OnTick(T0.AddSeconds(1), connected: true);
        var woken = _runtime.Version;
        _runtime.OnMessage(Msg("a/b", "1"), T0.AddSeconds(1));

        Assert.True(woken > before);
        Assert.True(_runtime.Version > woken);
    }

    // ---- reading messages, and what a run keeps to itself ----

    [Fact]
    public void A_message_read_in_a_loop_keeps_the_turn_as_its_index()
    {
        Activate(Body("for", new { times = "2" },
            ("read", "mqttIn", new { filter = "a/b" }),
            ("pub", "publish", new { topic = "out/{{index}}", payload = "{{payload}}" })).Compile());

        Assert.Equal(["out/1"], Topics(_runtime.OnMessage(Msg("a/b", "x"), T0)));
        Assert.Equal(["out/2"], Topics(_runtime.OnMessage(Msg("a/b", "y"), T0)));
    }

    [Fact]
    public void A_run_does_not_read_its_own_publish_but_another_run_does()
    {
        var talker = Line(
            ("pub", "publish", new { topic = "loop/x", payload = "1" }),
            ("read", "mqttIn", new { filter = "loop/x" }),
            ("say", "debug", null)).Compile();
        var listener = new ChartBuilder("f2").Node("start", "start").Node("read", "mqttIn", new { filter = "loop/x" })
            .Node("say", "debug").Node("end", "end").Then("start", "read", "say", "end").Compile();
        _runtime.Deploy([talker, listener], ["f1", "f2"], T0);

        Assert.Equal("f2", Assert.Single(_runtime.OnMessage(Msg("loop/x", "1"), T0).Debug).FlowId);
    }

    [Fact]
    public void Of_two_flows_with_one_id_the_first_is_the_one_that_counts()
    {
        var other = Line(("pub", "publish", new { topic = "second" })).Compile();

        Assert.Equal(["first"], Topics(_runtime.Deploy([Line(("pub", "publish", new { topic = "first" })).Compile(), other], ["f1"], T0)));

        _runtime.Deploy([], [], T0);
        Assert.Empty(_runtime.Deploy([Line(("pub", "publish", new { topic = "first" })).Off().Compile(), other], ["f1"], T0).Publishes);
    }

    [Fact]
    public void Variables_whose_names_differ_only_in_case_are_two_variables()
    {
        Activate(Line(("keep", "set", new { variable = "Limit", value = "3" })).Var("limit", "1").Var("Limit", "2").Compile());

        Assert.Equal("1", Run().Variables["limit"]);
        Assert.Equal("3", Run().Variables["Limit"]);
    }

    [Fact]
    public void A_test_starts_from_the_declared_values_whatever_the_active_run_has_set()
    {
        Activate(Remembers().Compile());
        _runtime.OnMessage(Msg("x/y", "seen"), T0);

        _runtime.StartTest(Remembers().Compile(), T0);

        Assert.Equal("seen", Run().Variables["n"]);
        Assert.Equal("start", Run(FlowRunKind.Test).Variables["n"]);
        Assert.Equal("read", Run(FlowRunKind.Test).At);
    }

    // ---- alarms, again: whose they are and when they end ----

    [Fact]
    public void An_active_run_that_reaches_an_end_leaves_its_alarms_up()
    {
        var chart = new ChartBuilder()
            .Node("start", "start").Node("hot", "alarmRaise", new { name = "Hot", level = "warn" }).Node("end", "end")
            .Then("start", "hot").Wire("hot", "raised", "end").Wire("hot", "up", "end");

        Assert.True(Assert.Single(Activate(chart.Compile()).Alarms).Raised);
        Assert.Equal(FlowRunState.Finished, Run().State);
        Assert.Single(_runtime.Alarms().Active);
    }

    [Fact]
    public void A_test_the_forever_guard_stopped_ends_its_alarms()
    {
        var chart = new ChartBuilder()
            .Node("start", "start").Node("loop", "for", new { forever = true })
            .Node("test", "if", new { field = "$.go", test = "exists" }).Node("pause", "wait", new { seconds = "1" })
            .Node("hot", "alarmRaise", new { name = "Hot", level = "warn" }).Node("end", "end")
            .Then("start", "loop").Wire("loop", "body", "test")
            .Wire("test", "yes", "pause").Wire("pause", "out", "loop", "next")
            .Wire("test", "no", "hot").Wire("hot", "raised", "loop", "next").Wire("hot", "up", "loop", "next")
            .Wire("loop", "done", "end");

        var outcome = _runtime.StartTest(chart.Compile(), T0);

        Assert.Equal(FlowRunState.Stopped, Run(FlowRunKind.Test).State);
        Assert.Equal([true, false], outcome.Alarms.Select(alarm => alarm.Raised));
        Assert.Equal("test ended", outcome.Alarms[1].Alert.ResolvedBy);
    }

    [Fact]
    public void A_new_test_ends_the_alarms_of_the_one_it_replaces()
    {
        _runtime.StartTest(Watch().Compile(), T0);
        _runtime.OnMessage(Msg("plant/k1/temp", "{\"temp\":94}"), T0);

        var replaced = _runtime.StartTest(Watch().Compile(), T0.AddSeconds(1));

        Assert.Equal("test ended", Assert.Single(replaced.Alarms).Alert.ResolvedBy);
        Assert.Empty(_runtime.Alarms().Active);
    }

    [Fact]
    public void A_tests_clear_closes_its_own_alarm_and_the_active_runs_closes_its_own()
    {
        Activate(Watch().Compile());
        _runtime.StartTest(Watch().Compile(), T0);
        _runtime.OnMessage(Msg("plant/k1/temp", "{\"temp\":94}"), T0);

        var cooled = _runtime.OnMessage(Msg("plant/k1/temp", "{\"temp\":80}"), T0);

        Assert.Equal(["flow-f1-hot", "flowtest-f1-hot"], cooled.Alarms.Select(alarm => alarm.Alert.RuleId));
        Assert.Empty(_runtime.Alarms().Active);
    }

    [Fact]
    public void Switching_a_flow_off_leaves_its_test_going_with_its_alarms()
    {
        Activate(Watch().Compile());
        _runtime.StartTest(Watch().Compile(), T0);
        _runtime.OnMessage(Msg("plant/k1/temp", "{\"temp\":94}"), T0);

        var off = _runtime.Deploy([Watch().Off().Compile()], ["f1"], T0);

        Assert.Equal("flow-f1-hot", Assert.Single(off.Alarms).Alert.RuleId);
        Assert.Equal("flowtest-f1-hot", Assert.Single(_runtime.Alarms().Active).RuleId);
        Assert.Equal(["f1"], _runtime.Testing());
        Assert.Equal(FlowRunState.Waiting, Run(FlowRunKind.Test).State);
    }

    // ---- how many tests are kept ----

    /// <summary>Start → End: a test that ends the moment it starts.</summary>
    private static CompiledFlow Ends(string id) =>
        new ChartBuilder(id).Node("start", "start").Node("end", "end").Then("start", "end").Compile();

    /// <summary>The flows with a test run kept, going or ended.</summary>
    private IReadOnlyList<string> Tests() =>
        [.. _runtime.Status().Runs.Where(run => run.Kind == FlowRunKind.Test).Select(run => run.FlowId)];

    [Fact]
    public void Stopping_a_test_that_has_ended_takes_it_away()
    {
        _runtime.StartTest(Ends("t1"), T0);
        Assert.Equal(["t1"], Tests());

        _runtime.StopTest("t1", remove: false, T0);

        Assert.Empty(Tests());
    }

    // A test kept stopped has ended, and a second Stop takes it away as it does any that has: the canvas is
    // cleared by pressing it again.
    [Fact]
    public void A_second_stop_takes_a_stopped_test_away()
    {
        _runtime.StartTest(Reader("t1"), T0);

        _runtime.StopTest("t1", remove: false, T0);
        Assert.Equal(["t1"], Tests());

        _runtime.StopTest("t1", remove: false, T0);
        Assert.Empty(Tests());
    }

    // A test that has ended stays to be read until something takes it away, and a console that went away
    // first takes nothing away: the tests of drafts nobody saved would pile up for the life of the process.
    // The one that goes is the oldest of those that have ended, by when it was started, and not by its name
    // or by where its flow first stood.
    [Fact]
    public void A_test_of_another_flow_lets_the_oldest_ended_test_go_once_fifty_are_kept()
    {
        // Started t49 first and t00 last, so the oldest are the last by name. Every tenth ends at once:
        // t44, t34, t24, t14 and t04, in that order.
        for (var i = 0; i < FlowLimits.Flows; i++)
        {
            var id = $"t{FlowLimits.Flows - 1 - i:00}";
            _runtime.StartTest(i % 10 == 5 ? Ends(id) : Reader(id), T0);
        }

        // t44 is tested again, and ends again: now the newest of the five.
        _runtime.StartTest(Ends("t44"), T0);

        var outcome = _runtime.StartTest(Reader("new"), T0);

        var tests = Tests();
        Assert.Equal(FlowLimits.Flows, tests.Count);
        Assert.Contains("new", tests);
        Assert.DoesNotContain("t34", tests);
        Assert.Contains("t44", tests);
        Assert.Contains("t04", tests);
        Assert.Empty(outcome.Debug);
    }

    // With every one of them going, a fifty-first is not started. FlowService refuses it before it gets
    // here, on the tests going and the starts waiting for the pump; this is the one that got past it, in a
    // race for the last place.
    [Fact]
    public void A_test_of_another_flow_is_not_started_while_fifty_are_going_and_says_so()
    {
        for (var i = 0; i < FlowLimits.Flows; i++) _runtime.StartTest(Reader($"t{i}"), T0);

        var outcome = _runtime.StartTest(Reader("new"), T0);

        Assert.DoesNotContain("new", Tests());
        Assert.Equal(FlowLimits.Flows, _runtime.Testing().Count);
        var line = Assert.Single(outcome.Debug);
        Assert.Equal(("new", "start", FlowDebugEntry.Error, true), (line.FlowId, line.NodeId, line.Kind, line.Test));
        Assert.Equal("At most 50 tests can run at once, so this one was not started. Stop one first.", line.Text);
    }

    [Fact]
    public void A_test_of_a_flow_with_one_kept_takes_its_place_while_fifty_are_going()
    {
        for (var i = 0; i < FlowLimits.Flows; i++) _runtime.StartTest(Reader($"t{i}"), T0);

        var outcome = _runtime.StartTest(Ends("t3"), T0);

        Assert.Equal(FlowLimits.Flows, Tests().Count);
        Assert.Equal(FlowRunState.Finished, Run(FlowRunKind.Test, "t3").State);
        Assert.Empty(outcome.Debug);
    }

    // ---- what a step will not send ----

    [Fact]
    public void A_topic_longer_than_MQTT_carries_is_not_published()
    {
        Activate(Line(("read", "mqttIn", new { filter = "a/b" }), ("pub", "publish", new { topic = "{{payload}}" })).Compile());

        Assert.Empty(_runtime.OnMessage(Msg("a/b", new string('x', FlowLimits.TopicBytes + 1)), T0).Publishes);
        Assert.Equal(1, Node("pub").Errors);
    }

    [Fact]
    public void A_payload_over_64_KB_is_not_published()
    {
        Activate(Line(("read", "mqttIn", new { filter = "a/b" }), ("pub", "publish", new { topic = "a/out", payload = "{{payload}}" })).Compile());

        Assert.Empty(_runtime.OnMessage(Msg("a/b", new string('x', FlowLimits.PayloadBytes + 1)), T0).Publishes);
        Assert.Equal(1, Node("pub").Errors);
    }

    [Fact]
    public void A_webhook_body_over_64_KB_is_not_posted()
    {
        Activate(Line(("read", "mqttIn", new { filter = "a/b" }), ("hook", "webhook", new { url = "https://hooks.example.com/x" })).Compile());

        Assert.Empty(_runtime.OnMessage(Msg("a/b", new string('x', FlowLimits.PayloadBytes + 1)), T0).Webhooks);
        Assert.Equal(1, Node("hook").Errors);
    }

    [Fact]
    public void A_notice_shows_its_first_200_characters()
    {
        var outcome = Activate(Line(("tell", "notify", new { text = new string('n', FlowLimits.TextTemplateLength), level = "info" })).Compile());

        Assert.Equal(new string('n', FlowLimits.NoticeLength), Assert.Single(outcome.Notices).Text);
    }

    // The link and the rate are asked before anything is rendered: a publish either of them refuses would
    // otherwise pay for its render first, and at the rate limit that is every publish past the fiftieth
    // each second. The random number in the payload counts the renders.
    [Fact]
    public void A_publish_the_link_or_the_rate_would_refuse_is_never_rendered()
    {
        var random = new CountingRandom(7);
        var runtime = new FlowRuntime(random);
        runtime.OnTick(T0, connected: true);
        var chart = Body("for", new { times = "60" }, ("pub", "publish", new { topic = "sim/x", payload = "{{random(0,1)}}" }));

        Assert.Equal(FlowLimits.PublishesPerSecond, runtime.Deploy([chart.Compile()], ["f1"], T0).Publishes.Count);
        Assert.Equal(FlowLimits.PublishesPerSecond, random.Draws);

        runtime.OnTick(T0.AddSeconds(2), connected: false);
        runtime.StartTest(chart.Compile(), T0.AddSeconds(2));

        Assert.Equal(FlowLimits.PublishesPerSecond, random.Draws);
    }

    // ---- what is said under a node ----

    [Fact]
    public void A_failure_that_quotes_a_long_text_is_cut_to_a_note_and_to_an_excerpt_in_the_debug_strip()
    {
        // The sentence that refuses a topic quotes the topic, which here is the whole payload.
        Activate(Line(("read", "mqttIn", new { filter = "a/b" }), ("pub", "publish", new { topic = "{{payload}}" })).Compile());

        var line = Assert.Single(_runtime.OnMessage(Msg("a/b", new string('x', 3 * FlowLimits.DebugExcerpt) + "+"), T0).Debug);

        Assert.Equal(FlowDebugEntry.Error, line.Kind);
        Assert.Equal(FlowLimits.DebugExcerpt, line.Text.Length);
        Assert.Equal(FlowLimits.NoteLength, Node("pub").Note!.Length);
        Assert.EndsWith("…", Node("pub").Note);
    }

    [Fact]
    public void A_note_is_one_line()
    {
        Activate(Line(("read", "mqttIn", new { filter = "a/b" }), ("say", "debug", null)).Compile());

        _runtime.OnMessage(Msg("a/b", "first\r\nsecond"), T0);

        Assert.Equal("first second", Node("say").Note);
    }

    // A note shows eighty characters and must cost about that: the line endings are replaced in what is
    // kept, not in a copy of the whole payload made first. The text is the same either way, so the
    // allocation is the proof: two copies of two megabytes against a few kilobytes.
    [Fact]
    public void A_note_costs_what_it_shows_and_not_a_copy_of_the_payload()
    {
        Activate(Body("for", new { forever = true }, ("read", "mqttIn", new { filter = "a/#" }), ("say", "debug", null)).Compile());
        _runtime.OnMessage(Msg("a/b", "warming up"), T0);

        var lines = Msg("a/b", string.Concat(Enumerable.Repeat("a line\n", 150_000)));
        var before = GC.GetAllocatedBytesForCurrentThread();
        _runtime.OnMessage(lines, T0);
        var allocated = GC.GetAllocatedBytesForCurrentThread() - before;

        Assert.StartsWith("a line a line ", Node("say").Note);
        Assert.Equal(FlowLimits.NoteLength, Node("say").Note!.Length);
        Assert.True(allocated < 64 * 1024, $"{allocated:N0} bytes were allocated to run one message into two notes.");
    }

    // A Set's note says the variable and its new value, and costs what it shows in the same way: a value of
    // sixty thousand characters is not copied whole into a sentence to show eighty of them. The value is
    // filled in from the message, since what is written in the box is held to 1,024 characters, and filling
    // it in costs what it costs whatever the note does: what is measured is the cost on top of that.
    [Fact]
    public void A_set_note_costs_what_it_shows_and_not_a_copy_of_the_value()
    {
        var flow = Body("for", new { forever = true },
            ("read", "mqttIn", new { filter = "a/b" }),
            ("keep", "set", new { variable = "n", value = "{{payload}}" })).Var("n", "").Compile();
        Activate(flow);
        _runtime.OnMessage(Msg("a/b", "warming up"), T0);

        var value = new string('v', 60_000);
        var template = Assert.IsType<SetNode>(flow.Nodes["keep"]).Value;

        var before = GC.GetAllocatedBytesForCurrentThread();
        template.Render(new FlowMessage("a/b", value, 1), new Dictionary<string, string>(), T0, new Random(1),
            FlowLimits.VariableBytes, out _);
        var rendered = GC.GetAllocatedBytesForCurrentThread() - before;

        before = GC.GetAllocatedBytesForCurrentThread();
        _runtime.OnMessage(Msg("a/b", value), T0);
        var allocated = GC.GetAllocatedBytesForCurrentThread() - before;

        Assert.StartsWith("n = vvv", Node("keep").Note);
        Assert.Equal(FlowLimits.NoteLength, Node("keep").Note!.Length);
        Assert.True(allocated - rendered < 64 * 1024,
            $"{allocated - rendered:N0} bytes were allocated, past filling the value in, to set a variable and say so.");
    }

    [Fact]
    public void A_variable_is_shown_as_an_excerpt()
    {
        Activate(Line(("say", "debug", null)).Var("long", new string('v', 2 * FlowLimits.NoteLength)).Compile());

        Assert.Equal(FlowLimits.NoteLength, Run().Variables["long"].Length);
    }

    // ---- what a message cannot do ----

    [Fact]
    public void A_field_that_cannot_be_read_as_text_is_not_there_and_the_run_goes_on()
    {
        // The drawing one message once stopped every flow with: a monitor whose If reads a field holding
        // an escaped half of a surrogate pair, beside a simulator that publishes every second.
        var monitor = new ChartBuilder()
            .Node("start", "start").Node("loop", "for", new { forever = true })
            .Node("read", "mqttIn", new { filter = "plant/+/temp" })
            .Node("test", "if", new { field = "$.temp", test = "gt", value = "90" }).Node("end", "end")
            .Then("start", "loop").Wire("loop", "body", "read").Then("read", "test")
            .Wire("test", "yes", "loop", "next").Wire("test", "no", "loop", "next").Wire("loop", "done", "end");
        var simulator = new ChartBuilder("f2")
            .Node("start", "start").Node("loop", "for", new { forever = true })
            .Node("pause", "wait", new { seconds = "1" }).Node("pub", "publish", new { topic = "sim/ping" }).Node("end", "end")
            .Then("start", "loop").Wire("loop", "body", "pause").Then("pause", "pub").Wire("pub", "out", "loop", "next")
            .Wire("loop", "done", "end");
        _runtime.Deploy([monitor.Compile(), simulator.Compile()], ["f1", "f2"], T0);

        _runtime.OnMessage(Msg("plant/k1/temp", """{"temp":"\ud800"}"""), T0);

        Assert.Equal(1, Node("test").Outs["no"]);
        Assert.Equal("no such field", Node("test").Note);
        Assert.Equal(FlowRunState.Waiting, Run().State);
        Assert.Equal(3, Enumerable.Range(1, 3).Sum(second => _runtime.OnTick(T0.AddSeconds(second), connected: true).Publishes.Count));
    }

    [Fact]
    public void For_each_leaves_out_an_element_that_cannot_be_read_as_text_and_says_so()
    {
        var chart = Body("forEach", new { array = "var.ids" }, ("pub", "publish", new { topic = "plant/{{payload}}", payload = "{{index}}" }))
            .Var("ids", """["k1","\udc00","k3"]""");

        var outcome = Activate(chart.Compile());

        Assert.Equal(["plant/k1", "plant/k3"], Topics(outcome));
        Assert.Equal(["1", "2"], outcome.Publishes.Select(Text));
        Assert.Equal(1, Node("loop").Errors);
    }

    /// <summary>A string element that cannot be read as text, as it is written in the JSON of an array.</summary>
    private const string Unreadable = "\"\\ud800\"";

    private static IEnumerable<string> Errors(FlowOutcome outcome) =>
        outcome.Debug.Where(line => line.Kind == FlowDebugEntry.Error).Select(line => line.Text);

    [Fact]
    public void For_each_counts_the_elements_it_cannot_read_toward_its_thousand()
    {
        // An array of strings that cannot be read as text is stopped at the limit as one of readable ones
        // is: scanned to its end instead, it would cost a thrown and caught exception for each of them,
        // on the pump that every flow shares.
        var array = "[" + string.Join(',', Enumerable.Repeat(Unreadable, FlowLimits.ForEachElements + 1)) + "]";

        var outcome = Activate(Body("forEach", new { array = "var.big" }, ("say", "debug", null)).Var("big", array).Compile());

        Assert.Equal(
        [
            "Only the first 1,000 elements are walked.",
            $"{FlowLimits.ForEachElements} elements could not be read as text, so they were left out.",
        ], Errors(outcome));
        Assert.Equal(2, Node("loop").Errors);
        Assert.DoesNotContain(outcome.Debug, line => line.Kind == FlowDebugEntry.Message);
        Assert.Equal(FlowRunState.Finished, Run().State);
    }

    [Fact]
    public void For_each_counts_the_elements_it_can_read_and_those_it_cannot_toward_one_thousand()
    {
        // The limit is on the elements looked at, so the one readable element that is the thousandth is
        // walked and the one after it is not.
        var array = "[" + string.Join(',', Enumerable.Repeat(Unreadable, FlowLimits.ForEachElements - 1)) + ",\"last\",\"beyond\"]";

        var outcome = Activate(Body("forEach", new { array = "var.mixed" }, ("say", "debug", null)).Var("mixed", array).Compile());

        Assert.Equal(["last"], outcome.Debug.Where(line => line.Kind == FlowDebugEntry.Message).Select(line => line.Text));
        Assert.Equal(
        [
            "Only the first 1,000 elements are walked.",
            $"{FlowLimits.ForEachElements - 1} elements could not be read as text, so they were left out.",
        ], Errors(outcome));
    }

    // The sentence is English, and so is its number. Written in the culture the server runs in, a host
    // set to Turkish or German formats would say "1.000", which an English reader takes for one.
    [Fact]
    public void The_limit_a_for_each_says_is_written_the_same_in_any_culture()
    {
        var array = "[" + string.Join(',', Enumerable.Range(0, FlowLimits.ForEachElements + 1)) + "]";
        var was = CultureInfo.CurrentCulture;

        try
        {
            CultureInfo.CurrentCulture = new CultureInfo("tr-TR");

            var outcome = Activate(Body("forEach", new { array = "var.big" }).Var("big", array).Compile());

            Assert.Equal(["Only the first 1,000 elements are walked."], Errors(outcome));
        }
        finally
        {
            CultureInfo.CurrentCulture = was;
        }
    }

    // ---- an arrival, and the runs it did not wake ----

    /// <summary>Start, then forever: read the next message on a/b. It wakes at every arrival there.</summary>
    private static CompiledFlow Reader(string id) => new ChartBuilder(id)
        .Node("start", "start").Node("loop", "for", new { forever = true }).Node("read", "mqttIn", new { filter = "a/b" })
        .Node("end", "end")
        .Then("start", "loop").Wire("loop", "body", "read").Wire("read", "out", "loop", "next").Wire("loop", "done", "end")
        .Compile();

    [Fact]
    public void An_arrival_moves_only_the_runs_it_woke()
    {
        // A run with steps left over takes them at the next tick: were every arrival in a pump turn to
        // move it as well, it would take another thousand steps at each.
        _runtime.Deploy([Body("for", new { times = "1000000" }, ("say", "debug", null)).Compile(), Reader("f2")], ["f1", "f2"], T0);

        var arrivals = Enumerable.Range(0, 10).SelectMany(i => _runtime.OnMessage(Msg("a/b", $"{i}"), T0).Debug).ToList();

        Assert.DoesNotContain(arrivals, line => line.FlowId == "f1");
        Assert.Equal(FlowRunState.Running, Run().State);
        Assert.Equal(500, _runtime.OnTick(T0, connected: true).Debug.Count(line => line.FlowId == "f1"));
    }

    [Fact]
    public void A_pattern_that_ran_out_of_time_costs_its_run_a_tick_and_not_every_arrival()
    {
        var hostile = new ChartBuilder().Var("text", HostilePatterns.Payload)
            .Node("start", "start").Node("loop", "for", new { times = "100" })
            .Node("test", "if", new { field = "var.text", test = "matches", value = HostilePatterns.Catastrophic })
            .Node("end", "end")
            .Then("start", "loop").Wire("loop", "body", "test")
            .Wire("test", "yes", "loop", "next").Wire("test", "no", "loop", "next").Wire("loop", "done", "end");
        _runtime.Deploy([hostile.Compile(), Reader("f2")], ["f1", "f2"], T0);

        for (var i = 0; i < 5; i++) _runtime.OnMessage(Msg("a/b", $"{i}"), T0);

        Assert.Equal(1, Node("test").Errors);
    }

    // ---- what a run lets go of when it ends ----

    /// <summary>Queues a message the run will never read, and keeps no more than a weak hold on its payload.</summary>
    // A method of its own, never inlined, so that nothing on the test's stack holds the payload once it
    // has returned: only the run's queue can keep it alive after that, and nothing reads a queue of a run
    // that has ended, so what it holds is seen only by whether the collector can take it.
    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private WeakReference Queued(string topic)
    {
        var payload = new string('q', 10_000);
        _runtime.OnMessage(Msg(topic, payload), T0);
        return new WeakReference(payload);
    }

    private static bool Collected(WeakReference weak)
    {
        GC.Collect();
        GC.WaitForPendingFinalizers();
        GC.Collect();
        return !weak.IsAlive;
    }

    [Fact]
    public void A_run_that_reaches_an_end_lets_go_of_the_messages_it_had_queued()
    {
        var chart = new ChartBuilder()
            .Node("start", "start").Node("first", "mqttIn", new { filter = "a/b" })
            .Node("test", "if", new { field = "", test = "eq", value = "stop" })
            .Node("second", "mqttIn", new { filter = "c/d" }).Node("end", "end")
            .Then("start", "first", "test").Wire("test", "yes", "end").Wire("test", "no", "second").Then("second", "end");
        Activate(chart.Compile());
        var queued = Queued("c/d");

        _runtime.OnMessage(Msg("a/b", "stop"), T0);

        Assert.Equal(FlowRunState.Finished, Run().State);
        Assert.True(Collected(queued));
    }

    // A test kept after Stop stays to be read until something takes it away, which can be a while: what was
    // queued for it is let go of when it stops, and not when it goes.
    [Fact]
    public void A_test_kept_after_its_stop_lets_go_of_the_messages_it_had_queued()
    {
        var chart = new ChartBuilder()
            .Node("start", "start").Node("first", "mqttIn", new { filter = "a/b" })
            .Node("second", "mqttIn", new { filter = "c/d" }).Node("end", "end")
            .Then("start", "first", "second", "end");
        _runtime.StartTest(chart.Compile(), T0);
        var queued = Queued("c/d");

        _runtime.StopTest("f1", remove: false, T0);

        Assert.Equal(FlowRunState.Stopped, Run(FlowRunKind.Test).State);
        Assert.True(Collected(queued));
    }

    [Fact]
    public void A_run_the_forever_guard_stopped_lets_go_of_the_messages_it_had_queued()
    {
        var chart = new ChartBuilder()
            .Node("start", "start").Node("first", "mqttIn", new { filter = "a/b" }).Node("loop", "for", new { forever = true })
            .Node("test", "if", new { field = "$.go", test = "exists" })
            .Node("second", "mqttIn", new { filter = "c/d" }).Node("say", "debug").Node("end", "end")
            .Then("start", "first", "loop").Wire("loop", "body", "test")
            .Wire("test", "yes", "second").Wire("second", "out", "loop", "next")
            .Wire("test", "no", "say").Wire("say", "out", "loop", "next")
            .Wire("loop", "done", "end");
        Activate(chart.Compile());
        var queued = Queued("c/d");

        _runtime.OnMessage(Msg("a/b", "{}"), T0);

        Assert.Equal(FlowRunState.Stopped, Run().State);
        Assert.True(Collected(queued));
    }

    // ---- a step that fails in a way no step expects ----

    [Fact]
    public void A_step_that_throws_stops_its_run_there_and_no_other()
    {
        // Nothing the product does is known to throw out of a step any more; a Random that throws on its
        // draw stands in for whatever will, through {{random}} in a Set's value.
        var runtime = new FlowRuntime(new BrokenRandom());
        runtime.OnTick(T0, connected: true);
        var broken = Line(("keep", "set", new { variable = "n", value = "{{random(0,1)}}" })).Var("n", "0").Compile();
        var other = new ChartBuilder("f2").Node("start", "start").Node("pub", "publish", new { topic = "a/b" }).Node("end", "end")
            .Then("start", "pub", "end").Compile();

        var outcome = runtime.Deploy([broken, other], ["f1", "f2"], T0);

        var run = runtime.Status().Runs.Single(one => one.FlowId == "f1");
        Assert.Equal(FlowRunState.Stopped, run.State);
        Assert.Equal("keep", run.At);

        // The exception's type as well as its message, as the alert engine records a rule's fault. A note
        // has room for no more than the start of the message; the debug line keeps all of this one.
        Assert.StartsWith("This step failed, so the run was stopped: InvalidOperationException: The dice", run.Fault);
        Assert.Equal(FlowLimits.NoteLength, run.Fault!.Length);
        Assert.Equal(1, run.Nodes.Single(node => node.Id == "keep").Errors);
        Assert.Contains(outcome.Debug, line => line.Kind == FlowDebugEntry.Error && line.NodeId == "keep" &&
            line.Text.StartsWith("This step failed, so the run was stopped: InvalidOperationException: The dice are lost, ", StringComparison.Ordinal));
        Assert.Equal("f2", Assert.Single(outcome.Publishes).Run.FlowId);
        Assert.Null(runtime.NextDue);
    }

    /// <summary>A Random whose every draw throws, with a message longer than a note.</summary>
    private sealed class BrokenRandom() : Random(7)
    {
        public override double NextDouble() =>
            throw new InvalidOperationException("The dice are lost, " + new string('x', 2 * FlowLimits.NoteLength));
    }

    /// <summary>A node of a type the compiler never makes: what a node added to the language and not yet to the runtime would be.</summary>
    private sealed class UnknownNode(string id) : CompiledNode(id);

    /// <summary>Start, then an <see cref="UnknownNode"/> called "odd", with nothing after it.</summary>
    private static CompiledFlow FlowWithUnknownNode()
    {
        var drawn = Line().Compile();
        var unknown = new UnknownNode("odd");

        // A way out is attached by the compiler alone, which no node it does not make can ask for, so the
        // one from Start is pointed at the odd node by hand. By name, so a rename is said as one here, and
        // not as a NullReferenceException that sends the reader looking at the runtime.
        var attach = typeof(CompiledNode).GetMethod("Attach", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)
                     ?? throw new InvalidOperationException(
                         "CompiledNode has no internal Attach(string, FlowTarget) any more, which the compiler used to wire a " +
                         "node's ways out. Point this test at whatever wires them now.");

        attach.Invoke(drawn.Start, ["out", new FlowTarget(unknown, "in")]);

        return new CompiledFlow
        {
            Id = drawn.Id,
            Name = drawn.Name,
            Enabled = true,
            Fingerprint = drawn.Fingerprint,
            Nodes = new Dictionary<string, CompiledNode>(drawn.Nodes) { ["odd"] = unknown },
            Start = drawn.Start,
            Inputs = [],
            Variables = [],
        };
    }

    [Fact]
    public void A_node_the_runtime_has_no_step_for_stops_its_run_there_and_does_not_leave_it_going()
    {
        // Nothing is thrown for the safety net to catch when a switch has no arm for a node, so without
        // one of its own the run would stay at the node and spin a thousand empty steps at every tick.
        var outcome = Activate(FlowWithUnknownNode());

        var run = Run();
        Assert.Equal(FlowRunState.Stopped, run.State);
        Assert.Equal("odd", run.At);
        Assert.StartsWith("This step failed, so the run was stopped: ", run.Fault);
        Assert.Contains(nameof(UnknownNode), Assert.Single(Errors(outcome)));
        Assert.Equal(1, Node("odd").Count);
        Assert.Equal(1, Node("odd").Errors);
        Assert.Null(_runtime.NextDue);
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
}
