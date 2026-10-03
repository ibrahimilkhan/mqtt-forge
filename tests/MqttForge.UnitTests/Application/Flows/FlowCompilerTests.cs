using MqttForge.Application.Flows;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;

namespace MqttForge.UnitTests.Application.Flows;

public partial class FlowCompilerTests
{
    private static readonly DateTimeOffset T0 = new(2026, 10, 3, 9, 0, 0, TimeSpan.Zero);
    private static readonly IReadOnlyDictionary<string, string> NoVariables = new Dictionary<string, string>();

    private static IReadOnlyList<FlowProblem> Problems(ChartBuilder chart) =>
        FlowCompiler.Compile(chart.Build(), ChartBuilder.Prefix).Problems;

    /// <summary>The one problem a flow has, failing the test with every problem when it has none or several.</summary>
    private static FlowProblem Only(ChartBuilder chart)
    {
        var problems = Problems(chart);
        Assert.True(problems.Count == 1, $"{problems.Count} problems: " + string.Join(" / ", problems.Select(p => $"{p.Key}: {p.Message}")));
        return problems[0];
    }

    /// <summary>Start → x → End, for a node x with one way in and one way out.</summary>
    private static ChartBuilder Step(string type, object? config = null) =>
        new ChartBuilder().Node("start", "start").Node("x", type, config).Node("end", "end").Then("start", "x", "end");

    /// <summary>Start → a loop whose body is <paramref name="body"/> (or empty) → End.</summary>
    private static ChartBuilder Loop(string type, object config, string? bodyType = null, object? bodyConfig = null)
    {
        var chart = new ChartBuilder().Node("start", "start").Node("loop", type, config).Node("end", "end")
            .Then("start", "loop").Wire("loop", "done", "end");

        return bodyType is null
            ? chart.Wire("loop", "body", "loop", "next")
            : chart.Node("b", bodyType, bodyConfig).Wire("loop", "body", "b").Wire("b", "out", "loop", "next");
    }

    // ---- the drawing ----

    [Fact]
    public void Start_wired_to_End_is_a_flow()
    {
        var flow = new ChartBuilder().Node("start", "start").Node("end", "end").Then("start", "end").Compile();

        Assert.IsType<EndNode>(flow.Start.To("out").Node);
        Assert.Equal("in", flow.Start.To("out").Port);
        Assert.Empty(flow.Inputs);
    }

    [Fact]
    public void A_flow_without_a_start_is_refused()
    {
        var problem = Only(new ChartBuilder().Node("end", "end"));

        Assert.Equal("flow", problem.Key);
        Assert.Contains("Start", problem.Message);
    }

    [Fact]
    public void A_second_start_is_refused_on_itself() =>
        Assert.Equal("node:again", Only(new ChartBuilder()
            .Node("start", "start").Node("again", "start").Node("end", "end")
            .Then("start", "end").Then("again", "end")).Key);

    [Fact]
    public void A_way_out_with_no_wire_is_refused_on_its_node()
    {
        var problem = Only(new ChartBuilder().Node("start", "start").Node("say", "debug").Then("start", "say"));

        Assert.Equal("node:say", problem.Key);
        Assert.Contains("goes nowhere", problem.Message);
    }

    [Fact]
    public void A_decision_names_the_way_out_that_goes_nowhere()
    {
        var problem = Only(new ChartBuilder()
            .Node("start", "start").Node("test", "if", new { field = "$.x", test = "exists" }).Node("end", "end")
            .Then("start", "test").Wire("test", "yes", "end"));

        Assert.Equal("node:test", problem.Key);
        Assert.Contains("no", problem.Message);
    }

    [Fact]
    public void A_way_out_with_two_wires_is_refused()
    {
        var problem = Only(new ChartBuilder()
            .Node("start", "start").Node("say", "debug").Node("a", "end").Node("b", "end")
            .Then("start", "say").Then("say", "a").Then("say", "b"));

        Assert.Equal("node:say", problem.Key);
        Assert.Contains("2 wires", problem.Message);
    }

    [Fact]
    public void Two_wires_may_come_into_one_way_in() =>
        new ChartBuilder()
            .Node("start", "start").Node("test", "if", new { field = "$.x", test = "exists" }).Node("end", "end")
            .Then("start", "test").Wire("test", "yes", "end").Wire("test", "no", "end")
            .Compile();

    [Fact]
    public void A_node_nothing_leads_to_is_refused()
    {
        var problem = Only(new ChartBuilder()
            .Node("start", "start").Node("end", "end").Node("lonely", "debug")
            .Then("start", "end").Then("lonely", "end"));

        Assert.Equal("node:lonely", problem.Key);
        Assert.Contains("Nothing leads here", problem.Message);
    }

    [Fact]
    public void A_circle_without_a_loop_is_refused()
    {
        var problem = Only(new ChartBuilder()
            .Node("start", "start").Node("a", "debug").Node("b", "debug")
            .Then("start", "a", "b", "a"));

        Assert.Equal("flow", problem.Key);
        Assert.Contains("circle", problem.Message);
    }

    [Fact]
    public void A_loop_with_an_empty_body_is_wired_to_itself()
    {
        var flow = Loop("for", new { times = "3" }).Compile();
        var loop = flow.Nodes["loop"];

        Assert.Same(loop, loop.To("body").Node);
        Assert.Equal("next", loop.To("body").Port);
        Assert.IsType<EndNode>(loop.To("done").Node);
    }

    [Fact]
    public void A_body_comes_back_to_its_loops_next() =>
        Loop("for", new { times = "3" }, "debug").Compile();

    [Fact]
    public void Nothing_coming_back_to_a_loop_is_refused()
    {
        var problem = Only(new ChartBuilder()
            .Node("start", "start").Node("loop", "for", new { times = "3" }).Node("end", "end")
            .Then("start", "loop").Wire("loop", "body", "end").Wire("loop", "done", "end"));

        Assert.Equal("node:loop", problem.Key);
        Assert.Contains("Nothing comes back", problem.Message);
    }

    [Fact]
    public void Only_the_loops_own_body_comes_back_to_its_next()
    {
        var problem = Only(new ChartBuilder()
            .Node("start", "start").Node("test", "if", new { field = "$.x", test = "exists" })
            .Node("loop", "for", new { times = "3" }).Node("end", "end")
            .Then("start", "test").Wire("test", "yes", "loop").Wire("test", "no", "loop", "next")
            .Wire("loop", "body", "loop", "next").Wire("loop", "done", "end"));

        Assert.Equal("edge:e3", problem.Key);
        Assert.Contains("own body", problem.Message);
    }

    [Fact]
    public void What_comes_after_a_loop_cannot_come_back_to_it()
    {
        var problem = Only(new ChartBuilder()
            .Node("start", "start").Node("loop", "for", new { times = "3" }).Node("after", "debug")
            .Then("start", "loop").Wire("loop", "body", "loop", "next").Wire("loop", "done", "after")
            .Wire("after", "out", "loop", "next"));

        Assert.Equal("edge:e4", problem.Key);
    }

    [Fact]
    public void Entering_a_loop_again_from_its_own_body_is_a_circle()
    {
        var problems = Problems(new ChartBuilder()
            .Node("start", "start").Node("loop", "for", new { times = "3" }).Node("again", "debug").Node("end", "end")
            .Then("start", "loop").Wire("loop", "body", "again").Then("again", "loop").Wire("loop", "done", "end"));

        Assert.Contains(problems, problem => problem.Key == "flow" && problem.Message.Contains("circle"));
    }

    [Fact]
    public void A_forever_loop_must_wait()
    {
        var problem = Only(Loop("for", new { forever = true }, "debug"));

        Assert.Equal("node:loop", problem.Key);
        Assert.Contains("must wait", problem.Message);
    }

    [Fact]
    public void A_forever_loop_waits_with_a_wait_or_a_read()
    {
        Loop("for", new { forever = true }, "wait", new { seconds = "1" }).Compile();
        Loop("for", new { forever = true }, "mqttIn", new { filter = "plant/+/temp" }).Compile();
    }

    [Theory]
    [InlineData("every")]
    [InlineData("inject")]
    [InlineData("repeat")]
    [InlineData("alarm")]
    public void A_type_from_the_old_set_is_not_known(string type)
    {
        var problems = Problems(new ChartBuilder().Node("start", "start").Node("end", "end").Then("start", "end").Node("old", type));

        Assert.Contains(problems, problem => problem.Key == "node:old" && problem.Message.Contains($"'{type}'"));
    }

    [Fact]
    public void A_flow_over_the_node_limit_is_refused_before_a_node_is_read()
    {
        var chart = new ChartBuilder();
        for (var i = 0; i <= 200; i++) chart.Node($"n{i}", "nonsense");

        var problem = Only(chart);
        Assert.Equal("flow", problem.Key);
        Assert.Contains("200 nodes", problem.Message);
    }

    // ---- settings ----

    [Fact]
    public void An_mqtt_in_needs_a_filter_and_keeps_out_of_the_alarm_prefix()
    {
        Assert.Equal("node:x", Only(Step("mqttIn")).Key);
        Assert.Contains(ChartBuilder.Prefix, Only(Step("mqttIn", new { filter = "mqttforge/alerts/#" })).Message);

        var input = Assert.Single(Step("mqttIn", new { filter = "plant/+/temp", replay = true }).Compile().Inputs);
        Assert.Equal("plant/+/temp", input.Filter);
        Assert.True(input.Replay);
    }

    private static ChartBuilder Decision(object config, Action<ChartBuilder>? also = null)
    {
        var chart = new ChartBuilder().Node("start", "start").Node("x", "if", config).Node("end", "end")
            .Then("start", "x").Wire("x", "yes", "end").Wire("x", "no", "end");
        also?.Invoke(chart);
        return chart;
    }

    [Theory]
    [InlineData("gt", "", "")]
    [InlineData("gt", "hot", "")]
    [InlineData("between", "90", "80")]
    [InlineData("between", "80", "")]
    [InlineData("matches", "(", "")]
    [InlineData("oneOf", " , ", "")]
    [InlineData("nope", "1", "")]
    public void An_if_with_a_value_its_test_cannot_use_is_refused(string test, string value, string value2) =>
        Assert.Equal("node:x", Only(Decision(new { field = "$.temp", test, value, value2 })).Key);

    [Fact]
    public void An_if_may_compare_with_a_variable_it_declares()
    {
        Decision(new { field = "$.temp", test = "gt", value = "{{var.limit}}" }, chart => chart.Var("limit", "90")).Compile();

        Assert.Contains("limit", Only(Decision(new { field = "$.temp", test = "gt", value = "{{var.limit}}" })).Message);
    }

    [Fact]
    public void An_if_reads_a_field_a_variable_or_the_payload_and_nothing_else()
    {
        Decision(new { field = "var.limit", test = "exists" }, chart => chart.Var("limit", "90")).Compile();
        Decision(new { field = "", test = "exists" }).Compile();

        Assert.Equal("node:x", Only(Decision(new { field = "temp", test = "exists" })).Key);
    }

    [Theory]
    [InlineData("")]
    [InlineData("2.5")]
    [InlineData("-1")]
    [InlineData("1000001")]
    public void For_needs_whole_times_or_forever(string times) =>
        Assert.Equal("node:loop", Only(Loop("for", new { times })).Key);

    [Fact]
    public void For_may_count_a_variable()
    {
        var chart = Loop("for", new { times = "{{var.n}}" }).Var("n", "3");
        var loop = Assert.IsType<ForNode>(chart.Compile().Nodes["loop"]);

        Assert.False(loop.Forever);
        Assert.Equal(["n"], loop.Times.Variables);
    }

    [Fact]
    public void For_each_reads_a_field_or_a_variable()
    {
        var loop = Assert.IsType<ForEachNode>(Loop("forEach", new { array = "var.sensors" }).Var("sensors", "[]").Compile().Nodes["loop"]);
        Assert.Equal("sensors", loop.Array.Variable);

        Assert.Equal("node:loop", Only(Loop("forEach", new { array = "sensors" })).Key);
    }

    [Theory]
    [InlineData("")]
    [InlineData("0.05")]
    [InlineData("86401")]
    [InlineData("soon")]
    public void Wait_needs_seconds_from_a_tenth_to_a_day(string seconds) =>
        Assert.Equal("node:x", Only(Step("wait", new { seconds })).Key);

    [Fact]
    public void Wait_may_read_its_seconds_from_a_variable() =>
        Step("wait", new { seconds = "{{var.delay}}" }).Var("delay", "2").Compile();

    [Fact]
    public void Set_names_a_variable_the_flow_declares()
    {
        var set = Assert.IsType<SetNode>(Step("set", new { variable = "limit", value = "{{$.limit}}" }).Var("limit", "90").Compile().Nodes["x"]);
        Assert.Equal("limit", set.Variable);

        Assert.Contains("limit", Only(Step("set", new { variable = "limit", value = "1" })).Message);
        Assert.Equal("node:x", Only(Step("set", new { variable = "", value = "1" })).Key);
    }

    [Fact]
    public void A_template_may_only_read_variables_the_flow_declares() =>
        Assert.Contains("site", Only(Step("publish", new { topic = "plant/{{var.site}}/cmd" })).Message);

    [Theory]
    [InlineData("")]
    [InlineData("plant/+/cmd")]
    public void Publish_needs_a_topic_it_can_publish_to(string topic) =>
        Assert.Equal("node:x", Only(Step("publish", new { topic, payload = "on" })).Key);

    private static ChartBuilder Alarm(object raise, object? clear = null)
    {
        var chart = new ChartBuilder().Node("start", "start").Node("raise", "alarmRaise", raise).Node("end", "end")
            .Then("start", "raise");

        return clear is null
            ? chart.Wire("raise", "raised", "end").Wire("raise", "up", "end")
            : chart.Node("clear", "alarmClear", clear).Wire("raise", "raised", "clear").Wire("raise", "up", "clear")
                .Wire("clear", "cleared", "end").Wire("clear", "none", "end");
    }

    [Fact]
    public void Raise_alarm_reads_its_name_level_reason_and_value()
    {
        var raise = Assert.IsType<AlarmRaiseNode>(Alarm(new { name = "Hot", level = "critical", reason = "{{topic[1]}} at {{$.temp}}", value = "$.temp" })
            .Compile().Nodes["raise"]);

        Assert.Equal("Hot", raise.Name);
        Assert.Equal(AlertSeverity.Critical, raise.Level);
        Assert.Equal("k1 at 94", raise.Reason.Render(new FlowMessage("plant/k1/temp", "{\"temp\":94}", 0), NoVariables, T0, new Random(1), 200, out _));
        Assert.Equal("$.temp", raise.Value.Text);
    }

    [Fact]
    public void A_reason_left_empty_says_the_alarms_name()
    {
        var raise = Assert.IsType<AlarmRaiseNode>(Alarm(new { name = "Hot", level = "warn" }).Compile().Nodes["raise"]);

        Assert.Equal("Hot", raise.Reason.Render(new FlowMessage("a", "", 0), NoVariables, T0, new Random(1), 200, out _));
    }

    [Theory]
    [InlineData("", "warn")]
    [InlineData("Hot", "loud")]
    public void Raise_alarm_needs_a_name_and_a_level(string name, string level) =>
        Assert.Equal("node:raise", Only(Alarm(new { name, level })).Key);

    [Fact]
    public void Clear_alarm_names_a_raise_alarm_of_its_flow()
    {
        var clear = Assert.IsType<AlarmClearNode>(Alarm(new { name = "Hot", level = "warn" }, new { alarm = "raise" }).Compile().Nodes["clear"]);
        Assert.Equal("raise", clear.Alarm);

        Assert.Contains("Pick", Only(Alarm(new { name = "Hot", level = "warn" }, new { alarm = "" })).Message);
        Assert.Contains("not in this flow", Only(Alarm(new { name = "Hot", level = "warn" }, new { alarm = "end" })).Message);
    }

    [Fact]
    public void Sound_and_notify_need_a_level_and_notify_needs_text()
    {
        Assert.Equal(AlertSeverity.Warn, Assert.IsType<SoundNode>(Step("sound", new { level = "warn" }).Compile().Nodes["x"]).Level);
        Assert.Equal("node:x", Only(Step("sound")).Key);

        Step("notify", new { text = "{{topic}} is hot", level = "info" }).Compile();
        Assert.Equal("node:x", Only(Step("notify", new { text = " ", level = "info" })).Key);
    }

    [Theory]
    [InlineData("")]
    [InlineData("ftp://hooks.example.com/x")]
    [InlineData("hooks.example.com/x")]
    [InlineData("https://user:secret@hooks.example.com/x")]
    public void Webhook_needs_a_plain_http_address(string url) =>
        Assert.Equal("node:x", Only(Step("webhook", new { url })).Key);

    [Fact]
    public void A_webhooks_body_is_the_payload_unless_it_says_otherwise()
    {
        var webhook = Assert.IsType<WebhookNode>(Step("webhook", new { url = "https://hooks.example.com/x" }).Compile().Nodes["x"]);

        Assert.Equal("https://hooks.example.com/x", webhook.Url);
        Assert.Equal("{\"temp\":94}", webhook.Body.Render(new FlowMessage("a", "{\"temp\":94}", 0), NoVariables, T0, new Random(1), 1000, out _));
    }

    // ---- variables ----

    [Theory]
    [InlineData("2nd")]
    [InlineData("my-limit")]
    public void A_variable_with_a_bad_name_is_refused(string name) =>
        Assert.Equal("flow", Only(Step("debug").Var(name, "1")).Key);

    [Fact]
    public void Two_variables_with_one_name_are_refused() =>
        Assert.Contains("limit", Only(Step("debug").Var("limit", "1").Var("limit", "2")).Message);

    [Fact]
    public void A_flow_keeps_at_most_fifty_variables()
    {
        var chart = Step("debug");
        for (var i = 0; i < 51; i++) chart.Var($"v{i}", "1");

        Assert.Contains("50", Only(chart).Message);
    }

    [Fact]
    public void A_starting_value_over_64_KB_is_refused() =>
        Assert.Equal("flow", Only(Step("debug").Var("big", new string('x', 64 * 1024 + 1))).Key);

    // ---- what a redeploy compares ----

    [Fact]
    public void Moving_a_node_keeps_the_fingerprint_and_a_new_starting_value_changes_it()
    {
        var flow = Step("debug").Var("limit", "90").Build();
        var moved = flow with { Nodes = [.. flow.Nodes.Select(node => node with { X = 300, Y = 40 })] };
        var changed = flow with { Variables = [new FlowVariable("limit", "95")] };

        var fingerprint = FlowCompiler.Compile(flow, ChartBuilder.Prefix).Flow!.Fingerprint;

        Assert.Equal(fingerprint, FlowCompiler.Compile(moved, ChartBuilder.Prefix).Flow!.Fingerprint);
        Assert.NotEqual(fingerprint, FlowCompiler.Compile(changed, ChartBuilder.Prefix).Flow!.Fingerprint);
    }

    [Fact]
    public void Compile_all_keeps_every_id_and_runs_only_what_compiled()
    {
        var good = new ChartBuilder("good").Node("start", "start").Node("end", "end").Then("start", "end").Build();
        var bad = new ChartBuilder("bad").Node("end", "end").Build();

        var set = FlowCompiler.CompileAll([good, bad], ChartBuilder.Prefix);

        Assert.Equal(["good"], set.Compiled.Select(flow => flow.Id));
        Assert.Equal(["good", "bad"], set.Kept);
        Assert.Equal("bad", Assert.Single(set.Problems).FlowId);
    }
}
