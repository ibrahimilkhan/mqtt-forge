using System.Text.Json;
using MqttForge.Application.Flows;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;

namespace MqttForge.UnitTests.Application.Flows;

public partial class FlowCompilerTests
{
    // FlowCompilerTests.cs takes one kind of setting at a time. This file holds every setting at its
    // limit and as the editor stores it, and what each node carries into the compiled flow.

    private static string Rendered(FlowTemplate template, FlowMessage? message = null) =>
        template.Render(message ?? new FlowMessage("a", "", 0), NoVariables, T0, new Random(1), 2_000, out _);

    private static IfNode IfFor(string test, string value = "", string value2 = "", Action<ChartBuilder>? also = null) =>
        Assert.IsType<IfNode>(Decision(new { field = "$.temp", test, value, value2 }, also).Compile().Nodes["x"]);

    // ---- MQTT in, If, For, Wait and Set ----

    [Fact]
    public void An_mqtt_in_trims_its_filter_and_replays_only_when_told_to()
    {
        var input = Assert.Single(Step("mqttIn", new { filter = " plant/+/temp " }).Compile().Inputs);

        Assert.Equal("plant/+/temp", input.Filter);
        Assert.False(input.Replay);
    }

    [Fact]
    public void An_mqtt_in_says_what_is_wrong_with_its_filter() =>
        Assert.Contains("'#' can only be the last level", Only(Step("mqttIn", new { filter = "plant/#/temp" })).Message);

    [Theory]
    [InlineData("gt", "91", "90", true)]
    [InlineData("gt", "90", "90", false)]
    [InlineData("gte", "90", "90", true)]
    [InlineData("gte", "89", "90", false)]
    [InlineData("lt", "89", "90", true)]
    [InlineData("lt", "90", "90", false)]
    [InlineData("lte", "90", "90", true)]
    [InlineData("lte", "91", "90", false)]
    [InlineData("eq", "on", "on", true)]
    [InlineData("eq", "off", "on", false)]
    [InlineData("neq", "off", "on", true)]
    [InlineData("neq", "on", "on", false)]
    public void An_if_decides_with_the_test_it_names(string test, string reading, string value, bool yes) =>
        Assert.Equal(yes, IfFor(test, value).Test.Judge(reading, value, ""));

    [Fact]
    public void An_if_that_is_between_one_of_or_exists_decides_as_each_does()
    {
        var between = IfFor("between", "80", "90").Test;
        Assert.True(between.Judge("85", "80", "90"));
        Assert.False(between.Judge("95", "80", "90"));

        Assert.True(IfFor("oneOf", "a, b").Test.Judge("b", "a, b", ""));
        Assert.False(IfFor("oneOf", "a, b").Test.Judge("c", "a, b", ""));

        Assert.True(IfFor("exists").Test.Judge("x", "", ""));
        Assert.False(IfFor("exists").Test.Judge(null, "", ""));
    }

    [Fact]
    public void An_if_carries_its_field_and_both_values()
    {
        var node = IfFor("between", "80", "{{var.high}}", chart => chart.Var("high", "90"));
        var high = new Dictionary<string, string> { ["high"] = "90" };

        Assert.Equal("$.temp", node.Field.Text);
        Assert.Equal("80", Rendered(node.Value));
        Assert.Equal("90", node.Value2.Render(new FlowMessage("a", "", 0), high, T0, new Random(1), 2_000, out _));
    }

    // Each test builds its node in a place of its own, so each is held to the field and the value it was given.
    [Theory]
    [InlineData("gt", "90")]
    [InlineData("gte", "90")]
    [InlineData("lt", "90")]
    [InlineData("lte", "90")]
    [InlineData("eq", "on")]
    [InlineData("neq", "on")]
    [InlineData("matches", "^on$")]
    [InlineData("oneOf", "on, off")]
    [InlineData("exists", "")]
    public void Every_test_carries_the_field_and_the_value_it_was_given(string test, string value)
    {
        var node = IfFor(test, value);

        Assert.Equal("$.temp", node.Field.Text);
        Assert.Equal(value, Rendered(node.Value));
    }

    [Fact]
    public void A_between_may_read_either_bound_from_a_variable_and_may_have_one_number_for_both()
    {
        IfFor("between", "{{var.low}}", "{{var.high}}", chart => chart.Var("low", "80").Var("high", "90"));
        IfFor("between", "80", "{{var.high}}", chart => chart.Var("high", "90"));
        IfFor("between", "80", "80");
    }

    // A pattern typed in is compiled while its writer is looking; one that reads a variable is the run's
    // to compile, from what the variable holds when the run gets there.
    [Fact]
    public void A_pattern_typed_in_is_compiled_once_and_one_from_a_variable_is_left_to_each_run()
    {
        var typed = IfFor("matches", "^k[0-9]$").Test;
        Assert.True(typed.Judge("k1", "never read", ""));
        Assert.False(typed.Judge("x1", "^x1$", ""));

        var read = IfFor("matches", "{{var.pattern}}", also: chart => chart.Var("pattern", "^k[0-9]$")).Test;
        Assert.True(read.Judge("x1", "^x1$", ""));
        Assert.False(read.Judge("k1", "^x1$", ""));
    }

    [Fact]
    public void A_pattern_that_does_not_compile_says_why()
    {
        const string Said = "This pattern does not compile: ";
        var message = Only(Decision(new { field = "$.temp", test = "matches", value = "(" })).Message;

        Assert.StartsWith(Said, message);
        Assert.True(message.Length > Said.Length, "the parser's reason is part of what is said");
    }

    [Fact]
    public void A_list_of_values_may_come_from_a_variable() =>
        IfFor("oneOf", "{{var.list}}", also: chart => chart.Var("list", "a,b"));

    [Fact]
    public void An_if_value_is_at_most_1024_characters()
    {
        Decision(new { field = "", test = "eq", value = new string('x', 1024) }).Compile();

        Assert.Equal("node:x", Only(Decision(new { field = "", test = "eq", value = new string('x', 1025) })).Key);

        // The second value is held to it by between, the one test that reads it, and by no other.
        Assert.Equal("node:x", Only(Decision(new { field = "", test = "between", value = "1", value2 = new string('1', 1025) })).Key);
        Decision(new { field = "", test = "eq", value = "on", value2 = new string('x', 1025) }).Compile();
    }

    [Fact]
    public void An_if_value_with_a_placeholder_it_cannot_fill_in_is_refused()
    {
        Assert.Equal("node:x", Only(Decision(new { field = "", test = "eq", value = "{{nope}}" })).Key);
        Assert.Contains("nope", Only(Decision(new { field = "", test = "between", value = "1", value2 = "{{var.nope}}" })).Message);
    }

    // The pane shows value for every test but exists and value2 for between alone, and keeps what was typed
    // in a box it hides. What is left there is not the node's: it cannot refuse it, and is carried as nothing.
    [Fact]
    public void A_second_value_cannot_refuse_a_test_other_than_between_and_is_carried_as_nothing()
    {
        var gt = IfFor("gt", "90", "{{var.gone}}");
        Assert.True(gt.Value2.IsLiteral);
        Assert.Equal("", Rendered(gt.Value2));

        Assert.Equal(
            "There is no variable called gone. Add it to the flow's variables.",
            Only(Decision(new { field = "$.temp", test = "between", value = "80", value2 = "{{var.gone}}" })).Message);
    }

    [Fact]
    public void A_value_cannot_refuse_exists_and_is_carried_as_nothing()
    {
        var exists = IfFor("exists", "{{var.gone}}", "{{var.gone}}");

        Assert.True(exists.Value.IsLiteral);
        Assert.Equal("", Rendered(exists.Value));
        Assert.True(exists.Value2.IsLiteral);
        Assert.Equal("", Rendered(exists.Value2));
    }

    // The pane hides times while forever is ticked, and keeps what was typed there.
    [Fact]
    public void A_forever_loop_does_not_read_its_times()
    {
        var loop = Assert.IsType<ForNode>(
            Loop("for", new { forever = true, times = "{{var.gone}}" }, "wait", new { seconds = "1" }).Compile().Nodes["loop"]);

        Assert.True(loop.Forever);
        Assert.True(loop.Times.IsLiteral);
        Assert.Equal("", Rendered(loop.Times));
    }

    [Fact]
    public void For_takes_no_turns_and_a_million_and_numbers_typed_or_stored()
    {
        Loop("for", new { times = "0" }).Compile();
        Loop("for", new { times = "1000000" }).Compile();

        var three = Assert.IsType<ForNode>(Loop("for", new { times = 3 }).Compile().Nodes["loop"]);
        Assert.Equal("3", Rendered(three.Times));
    }

    [Fact]
    public void For_with_nothing_to_count_says_to_say_how_many_or_tick_forever() =>
        Assert.Contains("forever", Only(Loop("for", new { times = "" })).Message);

    [Fact]
    public void For_counting_a_variable_the_flow_does_not_have_is_refused() =>
        Assert.Contains("nope", Only(Loop("for", new { times = "{{var.nope}}" })).Message);

    [Fact]
    public void Wait_with_no_seconds_says_so_and_one_it_cannot_fill_in_is_refused()
    {
        Assert.Contains("Say how many seconds", Only(Step("wait", new { seconds = "" })).Message);
        Assert.Equal("node:x", Only(Step("wait", new { seconds = "{{nope}}" })).Key);
        Assert.Contains("nope", Only(Step("wait", new { seconds = "{{var.nope}}" })).Message);
    }

    [Fact]
    public void Wait_takes_seconds_typed_as_a_number_too()
    {
        var wait = Assert.IsType<WaitNode>(Step("wait", new { seconds = 0.5 }).Compile().Nodes["x"]);

        Assert.Equal("0.5", Rendered(wait.Seconds));
    }

    [Fact]
    public void Set_trims_the_variable_and_carries_its_value()
    {
        var set = Assert.IsType<SetNode>(Step("set", new { variable = " limit ", value = "{{$.limit}}" }).Var("limit", "90").Compile().Nodes["x"]);

        Assert.Equal("limit", set.Variable);
        Assert.Equal("95", Rendered(set.Value, new FlowMessage("a", "{\"limit\":95}", 0)));
    }

    [Fact]
    public void Set_with_no_variable_says_to_pick_one_and_a_value_it_cannot_fill_in_is_refused()
    {
        Assert.Contains("Pick", Only(Step("set", new { variable = "", value = "1" })).Message);
        Assert.Equal("node:x", Only(Step("set", new { variable = "limit", value = "{{var.nope}}" }).Var("limit", "1")).Key);
    }

    // ---- Publish ----

    [Fact]
    public void Publish_carries_its_topic_payload_qos_and_retain()
    {
        var publish = Assert.IsType<PublishNode>(
            Step("publish", new { topic = " plant/{{topic[1]}}/cmd ", payload = "{\"fan\":\"on\"}", qos = 1, retain = true })
                .Compile().Nodes["x"]);

        Assert.Equal("plant/k1/cmd", Rendered(publish.Topic, new FlowMessage("plant/k1/temp", "", 0)));
        Assert.Equal("{\"fan\":\"on\"}", Rendered(publish.Payload));
        Assert.Equal(1, publish.Qos);
        Assert.True(publish.Retain);
    }

    [Fact]
    public void Publish_goes_at_qos_0_and_does_not_retain_unless_told_to()
    {
        var publish = Assert.IsType<PublishNode>(Step("publish", new { topic = "a" }).Compile().Nodes["x"]);

        Assert.Equal(0, publish.Qos);
        Assert.False(publish.Retain);
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(3)]
    public void Publish_asks_for_qos_0_1_or_2(int qos) =>
        Assert.Equal("QoS is 0, 1 or 2.", Only(Step("publish", new { topic = "a", qos })).Message);

    // A QoS is one of three whole numbers and 1.5 is none of them: it is refused, not cut down to 1.
    [Theory]
    [InlineData(1.5)]
    [InlineData("1.5")]
    public void A_qos_with_a_fraction_is_refused_and_not_cut_down(object qos) =>
        Assert.Equal("QoS is 0, 1 or 2.", Only(Step("publish", new { topic = "a", qos })).Message);

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    public void Every_qos_mqtt_has_is_taken_as_a_number_or_as_text(int qos)
    {
        Assert.Equal(qos, Assert.IsType<PublishNode>(Step("publish", new { topic = "a", qos }).Compile().Nodes["x"]).Qos);
        Assert.Equal(qos, Assert.IsType<PublishNode>(Step("publish", new { topic = "a", qos = qos.ToString() }).Compile().Nodes["x"]).Qos);
    }

    [Theory]
    [InlineData("plant/#")]
    [InlineData("+/cmd")]
    [InlineData("#")]
    public void Publish_does_not_take_a_wildcard_wherever_it_stands(string topic) =>
        Assert.Equal("node:x", Only(Step("publish", new { topic })).Key);

    [Theory]
    [InlineData("plant/{{colour}}", "x")]
    [InlineData("a", "{{nope}}")]
    [InlineData("a", "{{var.nope}}")]
    public void Publish_refuses_a_placeholder_it_cannot_fill_in(string topic, string payload) =>
        Assert.Equal("node:x", Only(Step("publish", new { topic, payload })).Key);

    [Fact]
    public void A_topic_is_at_most_1024_characters_and_a_payload_64_KB_counted_in_bytes()
    {
        Step("publish", new { topic = new string('t', FlowLimits.TopicTemplateLength) }).Compile();
        Assert.Contains("1024", Only(Step("publish", new { topic = new string('t', FlowLimits.TopicTemplateLength + 1) })).Message);

        Step("publish", new { topic = "a", payload = new string('x', FlowLimits.PayloadBytes) }).Compile();
        Assert.Contains("64 KB", Only(Step("publish", new { topic = "a", payload = new string('x', FlowLimits.PayloadBytes + 1) })).Message);
        Assert.Contains("64 KB", Only(Step("publish", new { topic = "a", payload = new string('é', FlowLimits.PayloadBytes / 2 + 1) })).Message);
    }

    // ---- the alarm steps ----

    [Fact]
    public void An_alarm_is_named_in_one_to_eighty_characters_and_the_name_is_trimmed()
    {
        Assert.Equal("Hot", Assert.IsType<AlarmRaiseNode>(Alarm(new { name = "  Hot  ", level = "warn" }).Compile().Nodes["raise"]).Name);

        Alarm(new { name = new string('n', 80), level = "warn" }).Compile();
        Assert.Equal("node:raise", Only(Alarm(new { name = new string('n', 81), level = "warn" })).Key);
    }

    [Theory]
    [InlineData("info", AlertSeverity.Info)]
    [InlineData("warn", AlertSeverity.Warn)]
    [InlineData("critical", AlertSeverity.Critical)]
    public void An_alarm_a_sound_and_a_notice_take_each_of_the_three_levels(string level, AlertSeverity expected)
    {
        Assert.Equal(expected, Assert.IsType<AlarmRaiseNode>(Alarm(new { name = "Hot", level }).Compile().Nodes["raise"]).Level);
        Assert.Equal(expected, Assert.IsType<SoundNode>(Step("sound", new { level }).Compile().Nodes["x"]).Level);
        Assert.Equal(expected, Assert.IsType<NotifyNode>(Step("notify", new { text = "hot", level }).Compile().Nodes["x"]).Level);
    }

    // The limit is on what is written in the box, and what an alarm shows of its reason is cut far shorter:
    // the sentence says both, so that nobody takes the one number for the other.
    [Fact]
    public void A_reason_is_at_most_1024_characters_and_one_of_blanks_says_the_alarms_name()
    {
        Alarm(new { name = "Hot", level = "warn", reason = new string('r', 1024) }).Compile();

        var tooLong = Only(Alarm(new { name = "Hot", level = "warn", reason = new string('r', 1025) }));
        Assert.Equal("node:raise", tooLong.Key);
        Assert.Equal("Write the reason in at most 1024 characters; only the first 200 are shown.", tooLong.Message);

        var blank = Assert.IsType<AlarmRaiseNode>(Alarm(new { name = "Hot", level = "warn", reason = "   " }).Compile().Nodes["raise"]);
        Assert.Equal("Hot", Rendered(blank.Reason));
    }

    // A reason left blank says the name as it was typed. A name is not a template: braces in it are part of
    // it, so it can neither be refused for a placeholder in a reason nobody wrote nor fill one in.
    [Fact]
    public void A_name_with_braces_in_it_is_not_refused_for_a_reason_nobody_wrote()
    {
        var raise = Assert.IsType<AlarmRaiseNode>(Alarm(new { name = "Pump {{nope}}", level = "warn" }).Compile().Nodes["raise"]);

        Assert.Equal("Pump {{nope}}", Rendered(raise.Reason));
    }

    [Fact]
    public void A_reason_left_blank_fills_in_nothing_the_name_holds()
    {
        var raise = Assert.IsType<AlarmRaiseNode>(Alarm(new { name = "{{topic}} is hot", level = "warn" }).Compile().Nodes["raise"]);

        Assert.Equal("{{topic}} is hot", Rendered(raise.Reason, new FlowMessage("plant/k1", "", 0)));
    }

    [Fact]
    public void A_reason_with_a_placeholder_it_cannot_fill_in_is_refused() =>
        Assert.Equal("node:raise", Only(Alarm(new { name = "Hot", level = "warn", reason = "{{var.nope}}" })).Key);

    [Fact]
    public void An_alarms_value_reads_a_field_a_variable_or_the_payload_and_nothing_else()
    {
        Alarm(new { name = "Hot", level = "warn", value = "" }).Compile();
        Alarm(new { name = "Hot", level = "warn", value = "var.limit" }).Var("limit", "90").Compile();

        Assert.Equal("node:raise", Only(Alarm(new { name = "Hot", level = "warn", value = "temp" })).Key);
        Assert.Equal("node:raise", Only(Alarm(new { name = "Hot", level = "warn", value = "var.nope" })).Key);
    }

    [Fact]
    public void A_clear_alarm_trims_its_pick_and_leaves_a_raise_alarms_mistakes_to_the_raise_alarm()
    {
        var clear = Assert.IsType<AlarmClearNode>(
            Alarm(new { name = "Hot", level = "warn" }, new { alarm = " raise " }).Compile().Nodes["clear"]);
        Assert.Equal("raise", clear.Alarm);

        Assert.Equal("node:raise", Only(Alarm(new { name = "Hot", level = "loud" }, new { alarm = "raise" })).Key);
    }

    // A notice's limit is said the way a reason's is, and for the same reason.
    [Fact]
    public void A_notice_is_at_most_1024_characters_and_carries_its_text_trimmed()
    {
        Step("notify", new { text = new string('t', 1024), level = "info" }).Compile();

        var tooLong = Only(Step("notify", new { text = new string('t', 1025), level = "info" }));
        Assert.Equal("node:x", tooLong.Key);
        Assert.Equal("Write the notice in at most 1024 characters; only the first 200 are shown.", tooLong.Message);

        var notify = Assert.IsType<NotifyNode>(Step("notify", new { text = "  {{topic}} is hot  ", level = "info" }).Compile().Nodes["x"]);
        Assert.Equal("plant/k1 is hot", Rendered(notify.Text, new FlowMessage("plant/k1", "", 0)));
    }

    [Fact]
    public void A_notice_with_a_placeholder_it_cannot_fill_in_or_a_level_it_does_not_know_is_refused()
    {
        Assert.Equal("node:x", Only(Step("notify", new { text = "{{var.nope}}", level = "info" })).Key);
        Assert.Equal("node:x", Only(Step("notify", new { text = "hot", level = "loud" })).Key);
    }

    [Fact]
    public void A_webhook_with_no_address_says_so() =>
        Assert.Contains("Give the address", Only(Step("webhook")).Message);

    [Fact]
    public void A_webhook_trims_its_address_and_takes_http_as_well_as_https()
    {
        var http = Assert.IsType<WebhookNode>(Step("webhook", new { url = "  http://hooks.example.com/x  " }).Compile().Nodes["x"]);

        Assert.Equal("http://hooks.example.com/x", http.Url);
        Step("webhook", new { url = "https://hooks.example.com/x" }).Compile();
    }

    [Fact]
    public void A_webhooks_address_is_at_most_2048_characters()
    {
        static string Address(int length) =>
            "https://hooks.example.com/" + new string('a', length - "https://hooks.example.com/".Length);

        Step("webhook", new { url = Address(FlowLimits.UrlLength) }).Compile();
        Assert.Equal("node:x", Only(Step("webhook", new { url = Address(FlowLimits.UrlLength + 1) })).Key);
    }

    [Fact]
    public void A_webhooks_body_is_what_it_says_unless_it_is_blank_and_is_at_most_64_KB()
    {
        const string Url = "https://hooks.example.com/x";

        var said = Assert.IsType<WebhookNode>(Step("webhook", new { url = Url, body = "{\"at\":\"{{topic}}\"}" }).Compile().Nodes["x"]);
        Assert.Equal("{\"at\":\"plant/k1\"}", Rendered(said.Body, new FlowMessage("plant/k1", "{}", 0)));

        var blank = Assert.IsType<WebhookNode>(Step("webhook", new { url = Url, body = "  " }).Compile().Nodes["x"]);
        Assert.Equal("{}", Rendered(blank.Body, new FlowMessage("plant/k1", "{}", 0)));

        Step("webhook", new { url = Url, body = new string('x', FlowLimits.PayloadBytes) }).Compile();
        Assert.Equal("node:x", Only(Step("webhook", new { url = Url, body = new string('x', FlowLimits.PayloadBytes + 1) })).Key);
        Assert.Equal("node:x", Only(Step("webhook", new { url = Url, body = "{{var.nope}}" })).Key);
    }

    // ---- variables ----

    [Fact]
    public void A_flow_keeps_fifty_variables_and_not_one_more()
    {
        var chart = Step("debug");
        for (var i = 0; i < FlowLimits.Variables; i++) chart.Var($"v{i}", "1");

        chart.Compile();
    }

    // Past the limit only the count is said, as it is for nodes and wires, and no variable is judged on its
    // own. A node still reads the names that are there, so it is not told that a variable it reads is missing.
    [Fact]
    public void Past_fifty_variables_only_the_count_is_said()
    {
        var chart = Step("publish", new { topic = "plant/{{var.limit}}" });
        for (var i = 0; i <= FlowLimits.Variables; i++) chart.Var("limit", "90");

        Assert.Equal("A flow has at most 50 variables.", Only(chart).Message);
    }

    [Fact]
    public void A_starting_value_is_at_most_64_KB_counted_in_bytes()
    {
        Step("debug").Var("big", new string('x', FlowLimits.VariableBytes)).Compile();
        Step("debug").Var("big", new string('é', FlowLimits.VariableBytes / 2)).Compile();

        Assert.Equal("flow", Only(Step("debug").Var("big", new string('é', FlowLimits.VariableBytes / 2 + 1))).Key);
    }

    [Fact]
    public void A_long_name_is_quoted_forty_characters_at_most_in_what_is_said_of_it()
    {
        var problems = Problems(Step("debug").Var("a-" + new string('b', 10_000), new string('x', FlowLimits.VariableBytes + 1)));

        Assert.Equal(2, problems.Count);
        Assert.All(problems, problem => Assert.True(problem.Message.Length < 200, problem.Message));
    }

    [Fact]
    public void A_variable_with_a_bad_name_is_refused_whatever_it_starts_at() =>
        Assert.Equal("flow", Only(Step("debug").Var("2nd", "")).Key);

    [Fact]
    public void Variable_names_are_told_apart_by_case()
    {
        Step("debug").Var("limit", "1").Var("Limit", "2").Compile();

        Assert.Contains("Limit", Only(Step("publish", new { topic = "a/{{var.Limit}}" }).Var("limit", "1")).Message);
    }

    // ---- the compiled flow ----

    [Fact]
    public void A_compiled_flow_carries_its_id_its_trimmed_name_its_state_and_its_variables()
    {
        var flow = Whole("flow-1", "  Boiler watch  ").Var("limit", "90").Off().Compile();

        Assert.Equal("flow-1", flow.Id);
        Assert.Equal("Boiler watch", flow.Name);
        Assert.False(flow.Enabled);
        Assert.Equal([new FlowVariable("limit", "90")], flow.Variables);
    }

    // A node written without settings has an undefined JsonElement, which cannot even be written out as
    // text, and settings that are not an object have no setting in them to read. Neither may be a crash.
    [Fact]
    public void Settings_that_are_missing_or_are_not_an_object_are_no_settings_and_not_a_crash()
    {
        var whole = Whole().Build();
        var undefined = whole with { Nodes = [.. whole.Nodes.Select(node => node with { Config = default })] };
        Assert.NotNull(FlowCompiler.Compile(undefined, ChartBuilder.Prefix).Flow?.Fingerprint);

        var wait = Step("wait").Build();
        var array = JsonDocument.Parse("[1,2]").RootElement;
        var odd = wait with { Nodes = [.. wait.Nodes.Select(node => node.Id == "x" ? node with { Config = array } : node)] };
        Assert.Contains("Say how many seconds", Assert.Single(FlowCompiler.Compile(odd, ChartBuilder.Prefix).Problems).Message);
    }

    // ---- text that cannot be read ----

    // Said of the node and not of one setting: the text can be in a name, in a box the pane hides, or on a
    // node that shows no settings at all, and the way out has to be one the reader can take from there.
    private const string Unreadable =
        "This node's settings hold text that cannot be read. Retype what you can, or delete the node and draw it again.";

    /// <summary>Start → x → End, as <see cref="Step"/>, for settings written as the JSON text they arrive in.</summary>
    private static ChartBuilder RawStep(string type, string settings) =>
        new ChartBuilder().Node("start", "start").RawNode("x", type, settings).Node("end", "end").Then("start", "x", "end");

    // An escaped half of a surrogate pair is valid JSON and no .NET string, and a PUT body or a flows.json
    // somebody edited can hold one in a setting as easily as any other text. GetString throws on it, and the
    // engine compiles every flow at start without a catch, so one such flow would stop all of them. It is a
    // setting that cannot be used, and a node that holds one is refused on itself like any other.
    [Theory]
    [InlineData("""{"topic":"plant/\ud800","payload":"on"}""")]
    [InlineData("""{"topic":"plant/k1","payload":"\udc00 on"}""")]
    public void A_setting_that_cannot_be_read_as_text_is_a_problem_on_its_node(string settings)
    {
        var problem = Only(RawStep("publish", settings));

        Assert.Equal("node:x", problem.Key);
        Assert.Equal(Unreadable, problem.Message);
    }

    // A number is read out of text as well, since the editor writes what a text box holds, and text that
    // cannot be read is not a number. What is said is that it cannot be read, and not a QoS nobody chose.
    [Fact]
    public void A_number_written_as_text_that_cannot_be_read_is_a_problem_on_its_node_and_not_a_crash()
    {
        var problem = Only(RawStep("publish", """{"topic":"plant/k1","payload":"on","qos":"\ud800"}"""));

        Assert.Equal("node:x", problem.Key);
        Assert.Equal(Unreadable, problem.Message);
    }

    // The whole of a node's settings is judged, and not only what its kind reads. A name is text too, and
    // looking one setting up reads the names on the way to it: last to first, and past every one of them
    // for a setting that is not there. Text in a setting nobody reads — a box the pane hides, one a newer
    // build wrote, anything on a Debug, which reads none — is still written out for the fingerprint and
    // into flows.json, and neither can write text that cannot be read. So it is refused where it is, and
    // not found out when the flow is compared or saved.
    [Theory]
    [InlineData("publish", """{"topic":"plant/k1","payload":"on","\ud800":1}""")]
    [InlineData("publish", """{"\ud800":1,"topic":"plant/k1","payload":"on"}""")]
    [InlineData("publish", """{"topic":"plant/k1","payload":"on","note":{"seen":["\ud800"]}}""")]
    [InlineData("debug", """{"note":"\ud800"}""")]
    public void Text_that_cannot_be_read_is_refused_wherever_in_a_nodes_settings_it_is(string type, string settings)
    {
        var problem = Only(RawStep(type, settings));

        Assert.Equal("node:x", problem.Key);
        Assert.Equal(Unreadable, problem.Message);
    }

    // The console marks every refused node at once, so a node refused for its text is still a node of the
    // drawing: its wires are wires, and what is wrong elsewhere is said beside it.
    [Fact]
    public void A_node_refused_for_text_that_cannot_be_read_still_takes_part_in_the_checks_of_the_drawing()
    {
        var problems = Problems(new ChartBuilder()
            .Node("start", "start").RawNode("x", "publish", """{"topic":"plant/\ud800","payload":"on"}""")
            .Node("end", "end").Node("say", "debug")
            .Then("start", "x", "end"));

        Assert.Contains(problems, problem => problem.Key == "node:x" && problem.Message.Contains("cannot be read"));
        Assert.Contains(problems, problem => problem.Key == "node:say" && problem.Message.Contains("goes nowhere"));
        Assert.DoesNotContain(problems, problem => problem.EdgeId is not null);
    }

    // The flows of a file are compiled one after another and the loop has no catch, so a flow that threw
    // would be every flow after it that never compiled — and, at start, none of them running.
    [Fact]
    public void Compile_all_still_compiles_the_flows_beside_one_that_holds_text_that_cannot_be_read()
    {
        var bad = new ChartBuilder("bad")
            .Node("start", "start").RawNode("x", "publish", """{"topic":"plant/\ud800","payload":"on"}""").Node("end", "end")
            .Then("start", "x", "end").Build();

        var set = FlowCompiler.CompileAll([bad, Whole("good").Build()], ChartBuilder.Prefix);

        Assert.Equal(["good"], set.Compiled.Select(flow => flow.Id));
        Assert.Equal(["bad", "good"], set.Kept);

        var problem = Assert.Single(set.Problems);
        Assert.Equal("bad", problem.FlowId);
        Assert.Equal("node:x", problem.Problem.Key);
    }

    // Kept is how the runtime tells a flow that was switched off from one that was taken away, and the
    // two end their alarms differently. A flow that is off is in the file, so it is in Kept, and it
    // compiles like any other: it is the runtime that leaves it idle.
    [Fact]
    public void Compile_all_compiles_and_keeps_a_flow_that_is_off()
    {
        var set = FlowCompiler.CompileAll([Whole("idle").Off().Build()], ChartBuilder.Prefix);

        Assert.False(Assert.Single(set.Compiled).Enabled);
        Assert.Equal(["idle"], set.Kept);
        Assert.Empty(set.Problems);
    }

    [Fact]
    public void Changing_what_a_node_does_or_where_a_wire_goes_changes_the_fingerprint()
    {
        static string Print(ChartBuilder chart) => FlowCompiler.Compile(chart.Build(), ChartBuilder.Prefix).Flow!.Fingerprint;

        static ChartBuilder Sorted(string yes, string no) =>
            new ChartBuilder().Node("start", "start").Node("test", "if", new { field = "$.x", test = "exists" })
                .Node("a", "end").Node("b", "end").Then("start", "test").Wire("test", "yes", yes).Wire("test", "no", no);

        var wait = Print(Step("wait", new { seconds = "1" }));

        Assert.NotEqual(wait, Print(Step("wait", new { seconds = "2" })));
        Assert.NotEqual(Print(Sorted("a", "b")), Print(Sorted("b", "a")));

        // The kind of a node is part of what it does: these two read the same settings and are wired alike.
        var both = new { times = "3", array = "$.list" };
        Assert.NotEqual(Print(Loop("for", both)), Print(Loop("forEach", both)));
    }

    // flows.json is written indented and with every é escaped, and a PUT body arrives compact and as it was
    // typed. One flow read from either is one flow, and an Update that finds them equal keeps its run.
    [Theory]
    [InlineData(
        "{\"topic\":\"plant/k1/cmd\",\"payload\":\"on\",\"qos\":1}",
        "{\n  \"topic\": \"plant/k1/cmd\",\n  \"payload\": \"on\",\n  \"qos\": 1\n}")]
    [InlineData("{\"topic\":\"plant/é/cmd\"}", "{\"topic\":\"plant/\\u00e9/cmd\"}")]
    public void The_fingerprint_does_not_depend_on_how_the_settings_are_spaced_or_escaped(string sent, string written)
    {
        var flow = Step("publish").Build();

        string Print(string config) => FlowCompiler.Compile(flow with
        {
            Nodes = [.. flow.Nodes.Select(node => node.Id == "x" ? node with { Config = JsonSerializer.Deserialize<JsonElement>(config) } : node)],
        }, ChartBuilder.Prefix).Flow!.Fingerprint;

        Assert.Equal(Print(sent), Print(written));
    }
}
