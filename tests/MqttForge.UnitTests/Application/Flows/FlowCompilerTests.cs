using MqttForge.Application.Flows;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;

namespace MqttForge.UnitTests.Application.Flows;

public class FlowCompilerTests
{
    private static IReadOnlyList<FlowProblem> Problems(FlowBuilder flow) =>
        FlowCompiler.Compile(flow.Build(), FlowBuilder.Prefix).Problems;

    private static FlowProblem Only(FlowBuilder flow) => Assert.Single(Problems(flow));

    // For the shapes FlowBuilder cannot draw: a null list, or a null element in one, or a null
    // field on a node or edge — everything System.Text.Json can still hand the compiler despite
    // what the record's constructor promises at compile time.
    private static FlowProblem Only(Flow flow) =>
        Assert.Single(FlowCompiler.Compile(flow, FlowBuilder.Prefix).Problems);

    private static FlowBuilder One(string type, object? config = null) =>
        new FlowBuilder().Node("n1", type, config);

    [Fact]
    public void The_boiler_watch_compiles_and_is_wired_port_by_port()
    {
        var flow = new FlowBuilder()
            .Node("in", "mqttIn", new { filter = "plant/+/temp" })
            .Node("test", "if", new { field = "$.temp", test = "gt", value = "90" })
            .Node("hot", "alarm", new { name = "Hot", severity = "critical", reason = "{{topic}}" })
            .Wire("in", "out", "test", "in")
            .Wire("test", "yes", "hot", "raise")
            .Wire("test", "no", "hot", "clear")
            .Compile();

        var input = Assert.Single(flow.Inputs);
        Assert.Equal("plant/+/temp", input.Filter);

        var test = Assert.IsType<IfNode>(Assert.Single(input.To("out")).Node);
        Assert.Equal("raise", Assert.Single(test.To("yes")).Port);
        Assert.Equal("clear", Assert.Single(test.To("no")).Port);

        var alarm = Assert.IsType<AlarmNode>(flow.Nodes["hot"]);
        Assert.Equal(AlertSeverity.Critical, alarm.Severity);
        Assert.IsType<ScreenAction>(Assert.Single(alarm.Actions));
    }

    [Fact]
    public void The_fingerprint_ignores_where_nodes_stand_and_notices_what_they_do()
    {
        var a = new FlowBuilder().Node("n1", "mqttIn", new { filter = "a/#" }).Build();
        var moved = a with { Nodes = [a.Nodes[0] with { X = 400, Y = 90 }] };
        var changed = new FlowBuilder().Node("n1", "mqttIn", new { filter = "b/#" }).Build();

        string Print(Flow flow) => FlowCompiler.Compile(flow, FlowBuilder.Prefix).Flow!.Fingerprint;

        Assert.Equal(Print(a), Print(moved));
        Assert.NotEqual(Print(a), Print(changed));
    }

    [Theory]
    [InlineData("")]
    [InlineData("has space")]
    [InlineData("an-id-that-is-far-too-long-to-be-an-id-here")]
    public void A_flow_id_outside_the_pattern_is_refused(string id)
    {
        var problem = Only(new FlowBuilder(id: id));

        Assert.Equal("flow", problem.Key);
    }

    [Fact]
    public void A_flow_needs_a_name() =>
        Assert.Equal("flow", Only(new FlowBuilder(name: "  ")).Key);

    [Fact]
    public void Two_nodes_may_not_share_an_id()
    {
        var problem = Only(new FlowBuilder().Node("n1", "debug").Node("n1", "debug"));

        Assert.Equal("node:n1", problem.Key);
    }

    [Fact]
    public void An_unknown_node_type_is_refused_by_name()
    {
        var problem = Only(One("teleport"));

        Assert.Equal("node:n1", problem.Key);
        Assert.Contains("teleport", problem.Message);
    }

    [Theory]
    [InlineData("")]
    [InlineData("plant/#/temp")]
    public void MQTT_in_needs_a_well_formed_filter(string filter) =>
        Assert.Equal("node:n1", Only(One("mqttIn", new { filter })).Key);

    // Seen live: plant/#/temp was refused with "Write a topic filter, like plant/+/temp.", which is
    // what an empty box needs to hear and not what somebody who wrote a filter does.
    [Fact]
    public void MQTT_in_says_what_is_wrong_with_its_filter() =>
        Assert.Contains("'#' can only be the last level", Only(One("mqttIn", new { filter = "plant/#/temp" })).Message);

    [Fact]
    public void MQTT_in_may_not_listen_where_alarms_are_published() =>
        Assert.Contains("mqttforge/alerts/", Only(One("mqttIn", new { filter = "mqttforge/#" })).Message);

    [Theory]
    [InlineData(0.05)]
    [InlineData(90_000)]
    public void Every_needs_an_interval_between_a_tenth_of_a_second_and_a_day(double seconds) =>
        Assert.Equal("node:n1", Only(One("every", new { seconds })).Key);

    [Theory]
    [InlineData("gt", "")]
    [InlineData("lt", "ninety")]
    [InlineData("between", "10")]
    [InlineData("matches", "(")]
    [InlineData("oneOf", " , ")]
    [InlineData("", "90")]
    public void If_needs_a_test_and_what_the_test_compares_with(string test, string value) =>
        Assert.Equal("node:n1", Only(One("if", new { field = "$.temp", test, value, value2 = "" })).Key);

    [Fact]
    public void Between_needs_its_bounds_the_right_way_round() =>
        Assert.Equal("node:n1", Only(One("if", new { test = "between", value = "20", value2 = "10" })).Key);

    [Theory]
    [InlineData(0, 1.0)]
    [InlineData(1001, 1.0)]
    [InlineData(3, 0.05)]
    [InlineData(3, 4000.0)]
    public void Repeat_needs_a_count_and_an_interval_it_can_keep(int count, double seconds) =>
        Assert.Equal("node:n1", Only(One("repeat", new { count, seconds })).Key);

    [Fact]
    public void Repeat_with_no_interval_is_allowed() =>
        Assert.Empty(Problems(One("repeat", new { count = 5, seconds = 0 })));

    [Fact]
    public void An_alarm_needs_a_name_and_a_level()
    {
        Assert.Equal("node:n1", Only(One("alarm", new { name = "", severity = "warn" })).Key);
        Assert.Equal("node:n1", Only(One("alarm", new { name = "Hot", severity = "loud" })).Key);
    }

    [Fact]
    public void An_alarm_asks_for_the_channels_it_names()
    {
        var alarm = Assert.IsType<AlarmNode>(One("alarm", new
        {
            name = "Hot", severity = "warn", sound = true, webhook = "https://hooks.example.com/boiler",
            publish = true, publishTopic = "", qos = 1, retain = true
        }).Compile().Nodes["n1"]);

        Assert.Collection(alarm.Actions,
            action => Assert.IsType<ScreenAction>(action),
            action => Assert.IsType<SoundAction>(action),
            action => Assert.Equal("https://hooks.example.com/boiler", Assert.IsType<WebhookAction>(action).Url),
            action =>
            {
                var publish = Assert.IsType<PublishAction>(action);
                Assert.Null(publish.Topic);
                Assert.Equal(1, publish.Qos);
                Assert.True(publish.Retain);
            });
    }

    [Fact]
    public void An_alarms_webhook_has_to_be_an_http_address() =>
        Assert.Equal("node:n1", Only(One("alarm", new { name = "Hot", severity = "warn", webhook = "ftp://x" })).Key);

    [Fact]
    public void An_alarms_own_topic_has_to_stay_under_the_alert_prefix() =>
        Assert.Equal("node:n1", Only(One("alarm", new
        {
            name = "Hot", severity = "warn", publish = true, publishTopic = "plant/alarm"
        })).Key);

    [Theory]
    [InlineData("")]
    [InlineData("plant/+/cmd")]
    [InlineData("plant/{{colour}}")]
    public void Publish_needs_a_topic_it_can_publish_to(string topic) =>
        Assert.Equal("node:n1", Only(One("publish", new { topic, payload = "x" })).Key);

    [Fact]
    public void Publish_refuses_a_payload_template_it_cannot_fill_in() =>
        Assert.Equal("node:n1", Only(One("publish", new { topic = "a", payload = "{{nope}}" })).Key);

    [Fact]
    public void A_wire_must_start_and_end_on_nodes_and_ports_that_exist()
    {
        var problems = Problems(new FlowBuilder()
            .Node("a", "inject")
            .Node("b", "debug")
            .Wire("a", "out", "ghost", "in")
            .Wire("a", "yes", "b", "in")
            .Wire("a", "out", "b", "raise"));

        Assert.Equal(["edge:e1", "edge:e2", "edge:e3"], problems.Select(p => p.Key));
    }

    [Fact]
    public void Two_wires_between_the_same_ports_are_refused() =>
        Assert.Equal("edge:e2", Only(new FlowBuilder()
            .Node("a", "inject").Node("b", "debug")
            .Wire("a", "out", "b", "in").Wire("a", "out", "b", "in")).Key);

    [Fact]
    public void Wires_that_go_round_in_a_circle_are_refused()
    {
        var problem = Only(new FlowBuilder()
            .Node("a", "forEach").Node("b", "repeat", new { count = 2, seconds = 0 })
            .Wire("a", "out", "b", "in").Wire("b", "out", "a", "in"));

        Assert.Equal("flow", problem.Key);
        Assert.Contains("circle", problem.Message);
    }

    [Fact]
    public void Too_many_nodes_are_refused()
    {
        var flow = new FlowBuilder();
        for (var i = 0; i <= FlowLimits.NodesPerFlow; i++) flow.Node($"n{i}", "debug");

        Assert.Equal("flow", Only(flow).Key);
    }

    // Refused on the count alone, before one node is read. Every node here is wrong in a way of its
    // own, so any node the compiler did read would be a problem of its own beside the count's — and
    // a flow fifty times over the limit costs what one node over it costs.
    [Fact]
    public void A_flow_far_over_the_node_limit_is_refused_before_any_node_is_read()
    {
        var flow = new FlowBuilder();
        for (var i = 0; i < 10_000; i++) flow.Node($"n{i}", "teleport");

        var problem = Only(flow);

        Assert.Equal("flow", problem.Key);
        Assert.Equal($"A flow holds at most {FlowLimits.NodesPerFlow} nodes.", problem.Message);
    }

    // The wires' twin: each of these leads to a node nobody drew, so any wire the compiler read would
    // be refused as well — and so would the circle check that walks every wire once per node.
    [Fact]
    public void A_flow_far_over_the_wire_limit_is_refused_before_any_wire_is_read()
    {
        var flow = new FlowBuilder().Node("a", "inject");
        for (var i = 0; i < 100_000; i++) flow.Wire("a", "out", $"ghost{i}", "in");

        var problem = Only(flow);

        Assert.Equal("flow", problem.Key);
        Assert.Equal($"A flow holds at most {FlowLimits.EdgesPerFlow} wires.", problem.Message);
    }

    [Fact]
    public void A_flow_holds_four_hundred_wires_and_not_one_more()
    {
        // Three Injects, each wired to every one of 134 Debug nodes: 402 wires to take from.
        FlowBuilder Wired(int wires)
        {
            var flow = new FlowBuilder();
            for (var i = 0; i < 3; i++) flow.Node($"go{i}", "inject");
            for (var j = 0; j < 134; j++) flow.Node($"say{j}", "debug");

            for (var n = 0; n < wires; n++) flow.Wire($"go{n % 3}", "out", $"say{n / 3}", "in");
            return flow;
        }

        Assert.Empty(Problems(Wired(FlowLimits.EdgesPerFlow)));
        Assert.Equal($"A flow holds at most {FlowLimits.EdgesPerFlow} wires.", Only(Wired(FlowLimits.EdgesPerFlow + 1)).Message);
    }

    [Fact]
    public void Two_wires_may_not_share_an_id()
    {
        var flow = new FlowBuilder()
            .Node("a", "inject").Node("b", "debug").Node("c", "debug")
            .Wire("a", "out", "b", "in")
            .Wire("a", "out", "c", "in")
            .Build();

        // Two edges that would otherwise both be fine, given the same id by hand rather than by
        // FlowBuilder's own counter — the one shape FlowBuilder itself never draws.
        var duplicated = flow with { Edges = [flow.Edges[0], flow.Edges[1] with { Id = flow.Edges[0].Id }] };

        var problem = Only(duplicated);

        Assert.Equal($"edge:{flow.Edges[0].Id}", problem.Key);
        Assert.Equal("A wire needs its own id.", problem.Message);
    }

    // System.Text.Json only promises these are never null at compile time. A hand-edited
    // flows.json, or a PUT body built by hand rather than by the console, can still leave any of
    // them out, and the compiler has to answer with problems, the same as it does for anything
    // else somebody got wrong — not with an exception that skips every other flow being compiled
    // alongside this one.

    [Fact]
    public void Missing_node_and_edge_lists_compile_as_an_empty_flow_not_a_crash()
    {
        var flow = new FlowBuilder().Build() with { Nodes = null!, Edges = null! };

        var result = FlowCompiler.Compile(flow, FlowBuilder.Prefix);

        Assert.Empty(result.Problems);
        Assert.Empty(result.Flow!.Nodes);
    }

    [Fact]
    public void A_null_node_in_the_list_is_a_flow_problem_not_a_crash()
    {
        var problem = Only(new FlowBuilder().Build() with { Nodes = [null!] });

        Assert.Equal("flow", problem.Key);
        Assert.Equal("A node in this flow is empty.", problem.Message);
    }

    [Fact]
    public void A_null_edge_in_the_list_is_a_flow_problem_not_a_crash()
    {
        var problem = Only(new FlowBuilder().Build() with { Edges = [null!] });

        Assert.Equal("flow", problem.Key);
        Assert.Equal("A wire in this flow is empty.", problem.Message);
    }

    [Fact]
    public void A_wire_with_no_source_node_is_refused_not_a_crash()
    {
        var flow = new FlowBuilder().Node("a", "inject").Node("b", "debug").Build();
        var broken = flow with { Edges = [new FlowEdge("e1", null!, "out", "b", "in")] };

        var problem = Only(broken);

        Assert.Equal("edge:e1", problem.Key);
        Assert.Equal("This wire does not start and end on nodes.", problem.Message);
    }

    [Fact]
    public void A_wire_with_no_destination_node_is_refused_not_a_crash()
    {
        var flow = new FlowBuilder().Node("a", "inject").Node("b", "debug").Build();
        var broken = flow with { Edges = [new FlowEdge("e1", "a", "out", null!, "in")] };

        var problem = Only(broken);

        Assert.Equal("edge:e1", problem.Key);
        Assert.Equal("This wire does not start and end on nodes.", problem.Message);
    }

    [Fact]
    public void A_wire_with_no_output_port_named_is_refused_not_a_crash()
    {
        var flow = new FlowBuilder().Node("a", "inject").Node("b", "debug").Build();
        var broken = flow with { Edges = [new FlowEdge("e1", "a", null!, "b", "in")] };

        var problem = Only(broken);

        Assert.Equal("edge:e1", problem.Key);
        Assert.Equal("This node has no output called ''.", problem.Message);
    }

    [Fact]
    public void A_wire_with_no_input_port_named_is_refused_not_a_crash()
    {
        var flow = new FlowBuilder().Node("a", "inject").Node("b", "debug").Build();
        var broken = flow with { Edges = [new FlowEdge("e1", "a", "out", "b", null!)] };

        var problem = Only(broken);

        Assert.Equal("edge:e1", problem.Key);
        Assert.Equal("That node has no input called ''.", problem.Message);
    }

    [Fact]
    public void A_node_with_no_type_named_hits_the_unknown_type_problem_not_a_crash()
    {
        var flow = new FlowBuilder().Build() with { Nodes = [new FlowNode("n1", null!, 0, 0, FlowJson.EmptyConfig)] };

        Assert.Equal("node:n1", Only(flow).Key);
    }

    [Fact]
    public void CompileAll_keeps_every_id_and_runs_only_what_compiled()
    {
        var set = FlowCompiler.CompileAll(
            [
                new FlowBuilder("good").Node("n1", "debug").Build(),
                new FlowBuilder("bad").Node("n1", "teleport").Build(),
            ],
            FlowBuilder.Prefix);

        Assert.Equal(["good", "bad"], set.Kept);
        Assert.Equal("good", Assert.Single(set.Compiled).Id);

        var problem = Assert.Single(set.Problems);
        Assert.Equal("bad", problem.FlowId);
        Assert.Equal("node:n1", problem.Problem.Key);
    }

    // Kept is how the runtime tells a flow turned off from one taken away, and the two end their
    // alarms differently — "flow off" and "flow removed". A flow that is off is still in the file,
    // so it has to be in Kept, and it compiles like any other: it is the runtime that leaves it idle.
    [Fact]
    public void CompileAll_compiles_and_keeps_a_flow_that_is_off()
    {
        var set = FlowCompiler.CompileAll([new FlowBuilder("idle").Node("n1", "debug").Off().Build()], FlowBuilder.Prefix);

        Assert.False(Assert.Single(set.Compiled).Enabled);
        Assert.Equal(["idle"], set.Kept);
        Assert.Empty(set.Problems);
    }
}
