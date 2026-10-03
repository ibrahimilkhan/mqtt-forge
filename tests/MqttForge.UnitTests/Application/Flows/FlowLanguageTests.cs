using MqttForge.Application.Flows;

namespace MqttForge.UnitTests.Application.Flows;

public class FlowLanguageTests
{
    private static readonly IReadOnlyDictionary<string, string> Limit = new Dictionary<string, string> { ["limit"] = "90" };

    // ---- the ports ----

    [Theory]
    [InlineData("start", "", "out")]
    [InlineData("end", "in", "")]
    [InlineData("mqttIn", "in", "out")]
    [InlineData("if", "in", "yes,no")]
    [InlineData("for", "in,next", "body,done")]
    [InlineData("forEach", "in,next", "body,done")]
    [InlineData("wait", "in", "out")]
    [InlineData("set", "in", "out")]
    [InlineData("publish", "in", "out")]
    [InlineData("debug", "in", "out")]
    [InlineData("alarmRaise", "in", "raised,up")]
    [InlineData("alarmClear", "in", "cleared,none")]
    [InlineData("sound", "in", "out")]
    [InlineData("notify", "in", "out")]
    [InlineData("webhook", "in", "out")]
    public void Every_type_has_the_ports_the_spec_gives_it(string type, string ins, string outs)
    {
        Assert.True(FlowPorts.Known(type));
        Assert.Equal(ins, string.Join(',', FlowPorts.Ins(type)));
        Assert.Equal(outs, string.Join(',', FlowPorts.Outs(type)));
    }

    // The old set's types are unknown to this one, like any type a newer build might write.
    [Theory]
    [InlineData("every")]
    [InlineData("inject")]
    [InlineData("repeat")]
    [InlineData("alarm")]
    public void The_old_types_are_not_known(string type)
    {
        Assert.False(FlowPorts.Known(type));
        Assert.Empty(FlowPorts.Ins(type));
        Assert.Empty(FlowPorts.Outs(type));
    }

    [Fact]
    public void Only_for_and_for_each_are_loops()
    {
        Assert.True(FlowPorts.IsLoop("for"));
        Assert.True(FlowPorts.IsLoop("forEach"));
        Assert.False(FlowPorts.IsLoop("if"));
    }

    // ---- variable names ----

    // Forty characters is the longest a name may be: a first one, then at most thirty-nine more. A
    // name that ends in a line break is no name either, whatever a regex's `$` would let through.
    [Theory]
    [InlineData("limit", true)]
    [InlineData("_x", true)]
    [InlineData("sensor_2", true)]
    [InlineData("2nd", false)]
    [InlineData("my-limit", false)]
    [InlineData("", false)]
    [InlineData("a234567890123456789012345678901234567890", true)]
    [InlineData("a2345678901234567890123456789012345678901", false)]
    [InlineData("limit\n", false)]
    public void A_variable_is_named_like_a_program_names_one(string name, bool valid) =>
        Assert.Equal(valid, FlowVariables.IsName(name));

    // ---- numbers ----

    [Theory]
    [InlineData("3", 3L)]
    [InlineData(" 0 ", 0L)]
    [InlineData("3.0", 3L)]
    [InlineData("1000000", 1_000_000L)]
    [InlineData("1000001", null)]
    [InlineData("2.5", null)]
    [InlineData("-1", null)]
    [InlineData("three", null)]
    [InlineData("", null)]
    public void Times_is_a_whole_number_up_to_a_million(string text, long? times) =>
        Assert.Equal(times, FlowNumbers.Times(text));

    [Theory]
    [InlineData("0.1", 0.1)]
    [InlineData("2", 2.0)]
    [InlineData("86400", 86_400.0)]
    [InlineData("0.05", null)]
    [InlineData("86401", null)]
    [InlineData("soon", null)]
    public void Seconds_are_from_a_tenth_to_a_day(string text, double? seconds) =>
        Assert.Equal(seconds is null ? (TimeSpan?)null : TimeSpan.FromSeconds(seconds.Value), FlowNumbers.Seconds(text));

    // ---- values ----

    [Fact]
    public void An_empty_value_reads_the_whole_payload()
    {
        var value = FlowValue.Parse("  ", out var problem);

        Assert.Null(problem);
        Assert.Null(value.Variable);
        Assert.Equal("94.2", value.Read(new FlowMessage("a", "94.2", 0), Limit));
    }

    [Fact]
    public void A_path_reads_a_field_and_a_missing_one_is_null()
    {
        var value = FlowValue.Parse("$.temp", out var problem);
        var message = new FlowMessage("a", "{\"temp\":94.2}", 0);

        Assert.Null(problem);
        Assert.Equal("94.2", value.Read(message, Limit));
        Assert.Null(FlowValue.Parse("$.hum", out _).Read(message, Limit));
    }

    [Fact]
    public void A_variable_reads_its_value_and_says_which_it_is()
    {
        var value = FlowValue.Parse("var.limit", out var problem);

        Assert.Null(problem);
        Assert.Equal("limit", value.Variable);
        Assert.Equal("90", value.Read(new FlowMessage("a", "x", 0), Limit));
        Assert.Null(FlowValue.Parse("var.other", out _).Read(new FlowMessage("a", "x", 0), Limit));
    }

    [Theory]
    [InlineData("temp")]
    [InlineData("var.2x")]
    [InlineData("var.")]
    public void Anything_else_is_a_problem(string text)
    {
        FlowValue.Parse(text, out var problem);

        Assert.NotNull(problem);
    }

    // What the editor shows back to the person is what they wrote, less the blanks round it.
    [Theory]
    [InlineData("", "")]
    [InlineData("  ", "")]
    [InlineData(" $.temp ", "$.temp")]
    [InlineData("var.limit ", "var.limit")]
    public void A_value_keeps_what_was_written_less_the_blanks_round_it(string written, string text) =>
        Assert.Equal(text, FlowValue.Parse(written, out _).Text);

    [Fact]
    public void The_limits_the_spec_gives_are_these()
    {
        Assert.Equal(1_000, FlowLimits.StepsPerTurn);
        Assert.Equal(1_000_000L, FlowLimits.ForTimes);
        Assert.Equal(1_000, FlowLimits.QueuedMessages);
        Assert.Equal(50, FlowLimits.Variables);
        Assert.Equal(64 * 1024, FlowLimits.VariableBytes);
        Assert.Equal(TimeSpan.FromSeconds(1), FlowLimits.ChannelEvery);
    }
}
