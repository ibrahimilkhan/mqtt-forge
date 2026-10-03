using MqttForge.Application.Flows.Next;
using MqttForge.Domain.Models;
using FlowJson = MqttForge.Application.Flows.FlowJson;
using FlowLimits = MqttForge.Application.Flows.FlowLimits;

namespace MqttForge.UnitTests.Application.Flows.Next;

public partial class FlowCompilerTests
{
    // FlowCompilerTests.cs takes one rule of the drawing at a time. This file holds what it leaves out:
    // every id and limit at its edge, wires that cannot be drawn, the ways a body may leave its loop,
    // and the two flows the spec draws, which no rule may be written tight enough to refuse.

    private static ChartBuilder Whole(string id = "f1", string name = "Boiler watch") =>
        new ChartBuilder(id, name).Node("start", "start").Node("end", "end").Then("start", "end");

    // ---- ids, names and the limits ----

    // A regex's $ also matches in front of a final line break, so an id written "n1\n" would pass the
    // pattern that is there to keep an id safe in a topic, a rule id and a file. The same goes for the
    // id of a flow, of a node and of a wire.
    [Fact]
    public void An_id_that_ends_in_a_line_break_is_refused()
    {
        Assert.Equal("flow", Only(new ChartBuilder("f1\n").Node("start", "start").Node("end", "end").Then("start", "end")).Key);

        var nodes = Problems(new ChartBuilder().Node("start", "start").Node("end\n", "end").Then("start", "end\n"));
        Assert.Contains(nodes, problem => problem.Key == "flow" && problem.Message.Contains("A node's id"));

        var flow = new ChartBuilder().Node("start", "start").Node("end", "end").Then("start", "end").Build();
        var broken = flow with { Edges = [flow.Edges[0] with { Id = "e1\n" }] };
        Assert.Contains(
            FlowCompiler.Compile(broken, ChartBuilder.Prefix).Problems,
            problem => problem.Key == "edge:e1\n" && problem.Message == "A wire needs its own id.");
    }

    // The three ids are written by one pattern, so the flow's pins it for all of them.
    [Theory]
    [InlineData("")]
    [InlineData("has space")]
    [InlineData("dotted.id")]
    public void A_flow_id_outside_the_pattern_is_refused(string id) =>
        Assert.Equal("flow", Only(Whole(id)).Key);

    [Fact]
    public void An_id_is_forty_letters_digits_dashes_or_underscores_at_most()
    {
        Whole("Boiler-watch_2").Compile();
        Whole(new string('a', 40)).Compile();

        Assert.Equal("flow", Only(Whole(new string('a', 41))).Key);
    }

    [Fact]
    public void A_node_and_a_wire_each_have_an_id_of_their_own()
    {
        Assert.Contains(
            Problems(Whole().Node("has space", "debug")),
            problem => problem.Key == "flow" && problem.Message.Contains("A node's id"));

        var flow = Step("debug").Build();
        var shared = flow with { Edges = [flow.Edges[0], flow.Edges[1] with { Id = flow.Edges[0].Id }] };
        Assert.Contains(
            FlowCompiler.Compile(shared, ChartBuilder.Prefix).Problems,
            problem => problem.Key == "edge:e1" && problem.Message == "A wire needs its own id.");

        Assert.Equal("node:x", Only(new ChartBuilder()
            .Node("start", "start").Node("x", "debug").Node("x", "debug").Node("end", "end")
            .Then("start", "x", "end")).Key);
    }

    [Fact]
    public void A_flow_is_named_in_one_to_eighty_characters()
    {
        Assert.Contains("Name the flow", Only(Whole(name: "   ")).Message);
        Assert.Contains("80", Only(Whole(name: new string('n', 81))).Message);

        Whole(name: new string('n', 80)).Compile();
    }

    [Fact]
    public void A_flow_holds_two_hundred_nodes_and_not_one_more()
    {
        static ChartBuilder Chain(int nodes)
        {
            var ids = new[] { "start" }.Concat(Enumerable.Range(0, nodes - 2).Select(i => $"d{i}")).Append("end").ToArray();
            var chart = new ChartBuilder();
            foreach (var id in ids) chart.Node(id, id is "start" or "end" ? id : "debug");

            return chart.Then(ids);
        }

        Chain(FlowLimits.NodesPerFlow).Compile();
        Assert.Contains("200 nodes", Only(Chain(FlowLimits.NodesPerFlow + 1)).Message);
    }

    // The same two ways wired over and over, since no flow of 200 nodes has 400 good wires: Start has
    // one way out and End none. What counts here is that only the count is said once it is past the limit.
    [Fact]
    public void A_flow_holds_four_hundred_wires_and_not_one_more()
    {
        static ChartBuilder Wired(int wires)
        {
            var chart = new ChartBuilder().Node("start", "start").Node("end", "end");
            for (var i = 0; i < wires; i++) chart.Wire("start", "out", "end");

            return chart;
        }

        Assert.DoesNotContain(Problems(Wired(FlowLimits.EdgesPerFlow)), problem => problem.Message.Contains("at most"));
        Assert.Equal("A flow holds at most 400 wires.", Only(Wired(FlowLimits.EdgesPerFlow + 1)).Message);
    }

    // A PUT body written by hand can leave a hole in a list, or a name out, and what comes back has to be
    // a problem: an exception would skip every other flow compiled beside this one.
    [Fact]
    public void A_hole_in_a_list_is_a_problem_and_not_a_crash()
    {
        var flow = Whole().Build();

        string[] Said(Flow broken) => [.. FlowCompiler.Compile(broken, ChartBuilder.Prefix).Problems.Select(problem => problem.Message)];

        Assert.Contains("A node in this flow is empty.", Said(flow with { Nodes = [.. flow.Nodes, null!] }));
        Assert.Contains("A wire in this flow is empty.", Said(flow with { Edges = [.. flow.Edges, null!] }));
        Assert.Contains("A variable in this flow is empty.", Said(flow with { Variables = [null!] }));
    }

    [Fact]
    public void A_node_with_no_type_is_one_this_build_does_not_know_and_not_a_crash()
    {
        var flow = Whole().Build();
        var untyped = flow with { Nodes = [.. flow.Nodes, new FlowNode("n1", null!, 0, 0, FlowJson.EmptyConfig)] };

        Assert.Contains(FlowCompiler.Compile(untyped, ChartBuilder.Prefix).Problems, problem => problem.Key == "node:n1");
    }

    // ---- wires ----

    [Fact]
    public void A_wire_must_start_and_end_on_nodes_and_ways_that_exist()
    {
        var problems = Problems(Whole()
            .Wire("start", "out", "ghost")
            .Wire("ghost", "out", "end")
            .Wire("start", "yes", "end")
            .Wire("start", "out", "end", "next"));

        Assert.Equal(["edge:e2", "edge:e3", "edge:e4", "edge:e5"], problems.Select(problem => problem.Key));
        Assert.Contains("'yes'", problems[2].Message);
        Assert.Contains("'next'", problems[3].Message);
    }

    [Fact]
    public void A_wire_with_a_way_not_named_is_refused_and_not_a_crash()
    {
        var flow = Whole().Build();
        var broken = flow with
        {
            Edges =
            [
                flow.Edges[0],
                new FlowEdge("e2", "start", null!, "end", "in"),
                new FlowEdge("e3", "start", "out", "end", null!),
            ],
        };

        var keys = FlowCompiler.Compile(broken, ChartBuilder.Prefix).Problems.Select(problem => problem.Key);
        Assert.Equal(["edge:e2", "edge:e3"], keys);
    }

    [Fact]
    public void Two_wires_between_the_same_ways_are_refused() =>
        Assert.Equal("edge:e2", Only(Whole().Wire("start", "out", "end")).Key);

    // Wires that differ in the way in they go to are two wires, so it is the way out that says it has two.
    [Fact]
    public void Two_wires_from_one_way_out_to_different_ways_in_are_two_wires_and_not_one_twice()
    {
        var problems = Problems(new ChartBuilder()
            .Node("start", "start").Node("loop", "for", new { times = "3" }).Node("end", "end")
            .Then("start", "loop").Wire("start", "out", "loop", "next").Wire("loop", "body", "loop", "next").Wire("loop", "done", "end"));

        Assert.Contains(problems, problem => problem.Key == "node:start" && problem.Message.Contains("2 wires"));
        Assert.DoesNotContain(problems, problem => problem.Message.Contains("same ports"));
    }

    [Fact]
    public void A_step_cannot_be_wired_to_itself() =>
        Assert.Equal("edge:e3", Only(new ChartBuilder().Node("start", "start").Node("say", "debug").Node("end", "end")
            .Then("start", "say", "end").Wire("say", "out", "say")).Key);

    // A loop with nothing in its body is wired to itself from its body to its next, and from no other
    // way out to any other way in.
    [Theory]
    [InlineData("body", "in")]
    [InlineData("done", "next")]
    [InlineData("done", "in")]
    public void A_loop_is_wired_to_itself_only_from_its_body_to_its_next(string from, string to)
    {
        var problems = Problems(new ChartBuilder()
            .Node("start", "start").Node("loop", "for", new { times = "3" }).Node("end", "end")
            .Then("start", "loop").Wire("loop", "body", "end").Wire("loop", "done", "end").Wire("loop", from, "loop", to));

        Assert.Contains(problems, problem => problem.Key == "edge:e4" && problem.Message.Contains("its own node"));
    }

    [Fact]
    public void A_way_out_is_named_by_its_port_when_a_node_has_two_and_by_the_node_when_it_has_one()
    {
        var decision = Only(new ChartBuilder()
            .Node("start", "start").Node("test", "if", new { field = "$.x", test = "exists" }).Node("end", "end")
            .Then("start", "test").Wire("test", "yes", "end"));
        Assert.Contains("The no way out goes nowhere", decision.Message);

        var step = Only(new ChartBuilder().Node("start", "start").Node("say", "debug").Then("start", "say"));
        Assert.Contains("This node's way out goes nowhere", step.Message);
    }

    // ---- loops ----

    // For and For each are one rule's two loops: every check of a loop is made of both.
    [Theory]
    [InlineData("for", "times", "3")]
    [InlineData("forEach", "array", "$.list")]
    public void Either_kind_of_loop_needs_something_to_come_back_to_its_next(string type, string setting, string value)
    {
        var problem = Only(new ChartBuilder()
            .Node("start", "start").Node("loop", type, new Dictionary<string, string> { [setting] = value }).Node("end", "end")
            .Then("start", "loop").Wire("loop", "body", "end").Wire("loop", "done", "end"));

        Assert.Equal("node:loop", problem.Key);
        Assert.Contains("Nothing comes back", problem.Message);
    }

    [Fact]
    public void A_node_in_both_the_body_and_what_comes_after_cannot_come_back_to_the_loop()
    {
        var problem = Only(new ChartBuilder()
            .Node("start", "start").Node("loop", "for", new { times = "3" }).Node("shared", "debug")
            .Then("start", "loop").Wire("loop", "body", "shared").Wire("loop", "done", "shared")
            .Wire("shared", "out", "loop", "next"));

        Assert.Equal("edge:e4", problem.Key);
    }

    [Fact]
    public void A_node_in_the_body_that_is_also_reached_before_the_loop_cannot_come_back_to_it()
    {
        var problem = Only(new ChartBuilder()
            .Node("start", "start").Node("test", "if", new { field = "$.x", test = "exists" })
            .Node("loop", "for", new { times = "3" }).Node("shared", "debug").Node("end", "end")
            .Then("start", "test").Wire("test", "yes", "loop").Wire("test", "no", "shared")
            .Wire("loop", "body", "shared").Wire("shared", "out", "loop", "next").Wire("loop", "done", "end"));

        Assert.Equal("edge:e5", problem.Key);
    }

    [Fact]
    public void A_node_nothing_leads_to_cannot_come_back_to_a_loop_either()
    {
        var problems = Problems(new ChartBuilder()
            .Node("start", "start").Node("loop", "for", new { times = "3" }).Node("lonely", "debug").Node("end", "end")
            .Then("start", "loop").Wire("loop", "body", "loop", "next").Wire("loop", "done", "end")
            .Wire("lonely", "out", "loop", "next"));

        Assert.Contains(problems, problem => problem.Key == "edge:e4");
    }

    [Fact]
    public void A_forever_loops_wait_has_to_be_in_its_body_and_not_after_it()
    {
        var problem = Only(new ChartBuilder()
            .Node("start", "start").Node("loop", "for", new { forever = true }).Node("say", "debug")
            .Node("pause", "wait", new { seconds = "1" }).Node("end", "end")
            .Then("start", "loop").Wire("loop", "body", "say").Wire("say", "out", "loop", "next")
            .Wire("loop", "done", "pause").Then("pause", "end"));

        Assert.Equal("node:loop", problem.Key);
        Assert.Contains("must wait", problem.Message);
    }

    [Fact]
    public void A_forever_loop_with_nothing_in_its_body_must_wait_whatever_comes_after_it()
    {
        var problem = Only(new ChartBuilder()
            .Node("start", "start").Node("loop", "for", new { forever = true }).Node("pause", "wait", new { seconds = "1" }).Node("end", "end")
            .Then("start", "loop").Wire("loop", "body", "loop", "next").Wire("loop", "done", "pause").Then("pause", "end"));

        Assert.Equal("node:loop", problem.Key);
        Assert.Contains("must wait", problem.Message);
    }

    // A break leaves the turn, so a Wait it goes on to is one the run reaches only once the turn is over:
    // the loop is refused alike with that Wait and without it, and told where a Wait has to go.
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void A_forever_loop_must_wait_in_its_turn_and_not_after_a_break(bool pause)
    {
        var chart = new ChartBuilder()
            .Node("start", "start").Node("loop", "for", new { forever = true })
            .Node("test", "if", new { field = "$.x", test = "exists" }).Node("end", "end")
            .Then("start", "loop").Wire("loop", "body", "test").Wire("test", "no", "loop", "next").Wire("loop", "done", "end");

        if (pause) chart.Node("pause", "wait", new { seconds = "1" }).Wire("test", "yes", "pause").Then("pause", "end");
        else chart.Wire("test", "yes", "end");

        var problem = Only(chart);
        Assert.Equal("node:loop", problem.Key);
        Assert.Equal("A forever loop must wait. Put a Wait or an MQTT in in its body, on the way back to its next.", problem.Message);
    }

    // Nor is a Wait after the loop around it, which the run reaches by breaking out into that loop's next
    // turn and going on through its done.
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void A_forever_loop_must_wait_in_its_turn_and_not_after_the_loop_around_it(bool pause)
    {
        var chart = new ChartBuilder()
            .Node("start", "start").Node("outer", "for", new { times = "3" }).Node("inner", "for", new { forever = true })
            .Node("test", "if", new { field = "$.x", test = "exists" }).Node("end", "end")
            .Then("start", "outer").Wire("outer", "body", "inner").Wire("inner", "body", "test")
            .Wire("test", "yes", "outer", "next").Wire("test", "no", "inner", "next").Wire("inner", "done", "outer", "next");

        if (pause) chart.Node("pause", "wait", new { seconds = "1" }).Wire("outer", "done", "pause").Then("pause", "end");
        else chart.Wire("outer", "done", "end");

        var problem = Only(chart);
        Assert.Equal("node:inner", problem.Key);
        Assert.Contains("must wait", problem.Message);
    }

    // Nor is a Wait the run passes before it comes to the loop: a turn is looked for in the body alone.
    [Fact]
    public void A_forever_loop_must_wait_in_its_turn_and_not_before_it()
    {
        var problem = Only(new ChartBuilder()
            .Node("start", "start").Node("pause", "wait", new { seconds = "1" }).Node("loop", "for", new { forever = true })
            .Node("say", "debug").Node("end", "end")
            .Then("start", "pause", "loop").Wire("loop", "body", "say").Wire("say", "out", "loop", "next").Wire("loop", "done", "end"));

        Assert.Equal("node:loop", problem.Key);
        Assert.Contains("must wait", problem.Message);
    }

    // A loop inside a forever loop is part of its turn: the inner loop's body leads back to the inner loop,
    // and the inner loop on to the forever loop's next. So the Wait may be in the inner loop or after it.
    [Fact]
    public void A_forever_loop_may_wait_inside_a_loop_it_holds_or_after_one()
    {
        new ChartBuilder()
            .Node("start", "start").Node("forever", "for", new { forever = true }).Node("each", "forEach", new { array = "$.list" })
            .Node("pause", "wait", new { seconds = "1" }).Node("end", "end")
            .Then("start", "forever").Wire("forever", "body", "each").Wire("each", "body", "pause").Wire("pause", "out", "each", "next")
            .Wire("each", "done", "forever", "next").Wire("forever", "done", "end").Compile();

        new ChartBuilder()
            .Node("start", "start").Node("forever", "for", new { forever = true }).Node("each", "forEach", new { array = "$.list" })
            .Node("say", "debug").Node("pause", "wait", new { seconds = "1" }).Node("end", "end")
            .Then("start", "forever").Wire("forever", "body", "each").Wire("each", "body", "say").Wire("say", "out", "each", "next")
            .Wire("each", "done", "pause").Wire("pause", "out", "forever", "next").Wire("forever", "done", "end").Compile();
    }

    [Fact]
    public void A_forever_loop_is_not_held_to_its_times()
    {
        var loop = Assert.IsType<ForNode>(
            Loop("for", new { forever = true, times = "soon" }, "wait", new { seconds = "1" }).Compile().Nodes["loop"]);

        Assert.True(loop.Forever);
    }

    // A body that is not forever may do without a Wait, and so may a For each.
    [Fact]
    public void Only_a_forever_for_has_to_wait()
    {
        Loop("for", new { times = "3" }, "debug").Compile();
        Loop("forEach", new { array = "$.list" }, "debug").Compile();
    }

    [Fact]
    public void A_body_may_break_out_of_its_loop_or_go_on_with_the_loop_around_it()
    {
        // To an End: the run ends there.
        new ChartBuilder()
            .Node("start", "start").Node("loop", "for", new { times = "5" }).Node("test", "if", new { field = "$.x", test = "exists" })
            .Node("stop", "end").Node("end", "end")
            .Then("start", "loop").Wire("loop", "body", "test").Wire("test", "yes", "stop").Wire("test", "no", "loop", "next")
            .Wire("loop", "done", "end").Compile();

        // To what the loop's own done leads to, like a break.
        new ChartBuilder()
            .Node("start", "start").Node("loop", "for", new { times = "5" }).Node("test", "if", new { field = "$.x", test = "exists" })
            .Node("past", "debug").Node("end", "end")
            .Then("start", "loop").Wire("loop", "body", "test").Wire("test", "yes", "past").Wire("test", "no", "loop", "next")
            .Wire("loop", "done", "past").Then("past", "end").Compile();

        // Out of an inner loop into the next turn of the one around it.
        new ChartBuilder()
            .Node("start", "start").Node("outer", "for", new { times = "2" }).Node("inner", "for", new { times = "2" })
            .Node("test", "if", new { field = "$.x", test = "exists" }).Node("say", "debug").Node("end", "end")
            .Then("start", "outer").Wire("outer", "body", "inner").Wire("inner", "body", "test")
            .Wire("test", "yes", "outer", "next").Wire("test", "no", "say").Wire("say", "out", "inner", "next")
            .Wire("inner", "done", "outer", "next").Wire("outer", "done", "end").Compile();
    }

    [Fact]
    public void Loops_may_follow_one_another_and_nest_with_nothing_in_them()
    {
        new ChartBuilder()
            .Node("start", "start").Node("a", "for", new { times = "2" }).Node("b", "forEach", new { array = "$.list" }).Node("end", "end")
            .Then("start", "a").Wire("a", "body", "a", "next").Wire("a", "done", "b")
            .Wire("b", "body", "b", "next").Wire("b", "done", "end").Compile();

        new ChartBuilder()
            .Node("start", "start").Node("a", "for", new { times = "2" }).Node("b", "for", new { times = "2" }).Node("end", "end")
            .Then("start", "a").Wire("a", "body", "b").Wire("b", "body", "b", "next")
            .Wire("b", "done", "a", "next").Wire("a", "done", "end").Compile();
    }

    // ---- the two flows the spec draws ----

    // Compiled, since they hold what a rule written too tight would refuse: loops inside loops, wires
    // that meet in one loop's next, and an alarm with both of its ways out wired.
    private static ChartBuilder BoilerSimulator() =>
        new ChartBuilder("simulator", "Boiler simulator").Var("sensors", "[\"k1\",\"k2\",\"k3\"]")
            .Node("start", "start").Node("forever", "for", new { forever = true }).Node("each", "forEach", new { array = "var.sensors" })
            .Node("pub", "publish", new { topic = "plant/{{payload}}/temp", payload = "{\"temp\": {{random(80,95)}}}" })
            .Node("pause", "wait", new { seconds = "2" }).Node("end", "end")
            .Then("start", "forever").Wire("forever", "body", "each").Wire("each", "body", "pub").Wire("pub", "out", "each", "next")
            .Wire("each", "done", "pause").Wire("pause", "out", "forever", "next").Wire("forever", "done", "end");

    private static ChartBuilder BoilerWatch() =>
        new ChartBuilder("watch", "Boiler watch").Var("limit", "90")
            .Node("start", "start").Node("forever", "for", new { forever = true }).Node("read", "mqttIn", new { filter = "plant/+/temp" })
            .Node("hot", "if", new { field = "$.temp", test = "gt", value = "{{var.limit}}" })
            .Node("raise", "alarmRaise", new { name = "Boiler too hot", level = "critical", reason = "{{topic[1]}} is at {{$.temp}}", value = "$.temp" })
            .Node("beep", "sound", new { level = "critical" }).Node("notice", "notify", new { text = "{{topic[1]}} is too hot", level = "critical" })
            .Node("fan", "publish", new { topic = "plant/{{topic[1]}}/cmd", payload = "{\"fan\":\"on\"}" })
            .Node("clear", "alarmClear", new { alarm = "raise" }).Node("end", "end")
            .Then("start", "forever").Wire("forever", "body", "read").Then("read", "hot")
            .Wire("hot", "yes", "raise").Wire("hot", "no", "clear")
            .Wire("raise", "raised", "beep").Then("beep", "notice", "fan").Wire("fan", "out", "forever", "next")
            .Wire("raise", "up", "forever", "next").Wire("clear", "cleared", "forever", "next").Wire("clear", "none", "forever", "next")
            .Wire("forever", "done", "end");

    [Fact]
    public void The_boiler_simulator_compiles_with_one_loop_inside_the_other()
    {
        var flow = BoilerSimulator().Compile();

        Assert.Equal("each", flow.Nodes["forever"].To("body").Node.Id);
        Assert.Equal("pause", flow.Nodes["each"].To("done").Node.Id);
        Assert.Equal(("forever", "next"), (flow.Nodes["pause"].To("out").Node.Id, flow.Nodes["pause"].To("out").Port));
        Assert.Equal(("each", "next"), (flow.Nodes["pub"].To("out").Node.Id, flow.Nodes["pub"].To("out").Port));
    }

    [Fact]
    public void The_boiler_watch_compiles_with_four_wires_meeting_in_one_loops_next()
    {
        var flow = BoilerWatch().Compile();

        Assert.Equal("plant/+/temp", Assert.Single(flow.Inputs).Filter);
        Assert.Equal("raise", flow.Nodes["hot"].To("yes").Node.Id);
        Assert.Equal("clear", flow.Nodes["hot"].To("no").Node.Id);
        Assert.Equal("beep", flow.Nodes["raise"].To("raised").Node.Id);

        foreach (var (from, port) in new[] { ("fan", "out"), ("raise", "up"), ("clear", "cleared"), ("clear", "none") })
            Assert.Equal(("forever", "next"), (flow.Nodes[from].To(port).Node.Id, flow.Nodes[from].To(port).Port));
    }
}
