using System.Globalization;
using System.Runtime.ExceptionServices;
using System.Text.Json;
using MqttForge.Application.Flows.Next;
using FlowLimits = MqttForge.Application.Flows.FlowLimits;
using FlowMessage = MqttForge.Application.Flows.FlowMessage;

namespace MqttForge.UnitTests.Application.Flows.Next;

public class FlowTemplateTests
{
    private static readonly DateTimeOffset T0 = new(2026, 9, 26, 9, 14, 22, 104, TimeSpan.Zero);

    private static readonly FlowMessage Reading =
        new("plant/k1/temp", "{\"temp\":94.2,\"fan\":\"off\"}", Index: 3);

    private static readonly IReadOnlyDictionary<string, string> Variables =
        new Dictionary<string, string> { ["limit"] = "90", ["site"] = "north" };

    private static string Render(string text, FlowMessage? message = null, int seed = 7)
    {
        var template = FlowTemplate.Parse(text, out var problem);
        Assert.Null(problem);

        var rendered = template.Render(message ?? Reading, Variables, T0, new Random(seed), FlowLimits.PayloadBytes, out var cut);
        Assert.False(cut);
        return rendered;
    }

    private static FlowTemplate Parsed(string text)
    {
        var template = FlowTemplate.Parse(text, out var problem);
        Assert.Null(problem);
        return template;
    }

    [Fact]
    public void Plain_text_is_copied_as_it_is() =>
        Assert.Equal("{\"fan\":\"on\"}", Render("{\"fan\":\"on\"}"));

    [Theory]
    [InlineData("{{topic}}", "plant/k1/temp")]
    [InlineData("{{ topic }}", "plant/k1/temp")]
    [InlineData("{{topic[0]}}", "plant")]
    [InlineData("{{topic[1]}}", "k1")]
    [InlineData("{{topic[9]}}", "")]
    [InlineData("{{payload}}", "{\"temp\":94.2,\"fan\":\"off\"}")]
    [InlineData("{{$.temp}}", "94.2")]
    [InlineData("{{$.fan}}", "off")]
    [InlineData("{{$.missing}}", "")]
    [InlineData("{{index}}", "3")]
    [InlineData("{{now}}", "2026-09-26T09:14:22.104Z")]
    [InlineData("plant/{{topic[1]}}/cmd", "plant/k1/cmd")]
    [InlineData("{{var.limit}}", "90")]
    [InlineData("{{ var.site }}/{{topic[1]}}", "north/k1")]
    [InlineData("{{var.other}}", "")]
    public void Each_placeholder_fills_in_what_the_spec_says(string text, string expected) =>
        Assert.Equal(expected, Render(text));

    [Fact]
    public void A_template_names_the_variables_it_reads()
    {
        Assert.Equal(["limit", "site"], Parsed("{{var.limit}} {{var.site}} {{var.limit}}").Variables.Order());
        Assert.Empty(Parsed("{{payload}}").Variables);
    }

    // A name is told from another by its case, as it is everywhere else a variable is looked up: a
    // flow that declares limit and reads {{var.Limit}} has to be told it reads one it does not have.
    [Fact]
    public void Two_variables_that_differ_only_in_case_are_two_variables() =>
        Assert.Equal(2, Parsed("{{var.limit}} {{var.Limit}}").Variables.Count);

    [Fact]
    public void Literal_means_no_placeholder_at_all()
    {
        Assert.True(Parsed("90").IsLiteral);
        Assert.True(Parsed("").IsLiteral);
        Assert.False(Parsed("{{var.limit}}").IsLiteral);
    }

    [Fact]
    public void A_field_of_a_payload_that_is_not_json_is_empty() =>
        Assert.Equal("", Render("{{$.temp}}", new FlowMessage("plant/k1/temp", "94.2", 1)));

    [Fact]
    public void Random_is_between_its_bounds_with_one_decimal()
    {
        for (var seed = 0; seed < 200; seed++)
        {
            var text = Render("{{random(80,95)}}", seed: seed);
            var value = double.Parse(text, CultureInfo.InvariantCulture);

            Assert.InRange(value, 80, 95);
            Assert.Matches(@"^\d+\.\d$", text);
        }
    }

    // \uFF11 and \uFF12 are the full-width digits one and two: a decimal digit to a pattern's \d, and no
    // digit at all to the parse that reads what it matched, which would throw where a problem is the answer.
    // Every run of digits a placeholder reads has a row of its own, so none can go back to \d unseen.
    [Theory]
    [InlineData("{{colour}}")]
    [InlineData("{{topic[x]}}")]
    [InlineData("{{topic[\uFF11]}}")]
    [InlineData("{{random(95,80)}}")]
    [InlineData("{{random(a,b)}}")]
    [InlineData("{{random(\uFF11,\uFF12)}}")]
    [InlineData("{{random(\uFF11,2)}}")]
    [InlineData("{{random(1,\uFF12)}}")]
    [InlineData("{{random(1.\uFF11,2)}}")]
    [InlineData("{{random(1,2.\uFF12)}}")]
    [InlineData("{{topic")]
    [InlineData("{{var.2x}}")]
    [InlineData("{{var.}}")]
    public void What_a_template_cannot_fill_in_is_a_problem(string text)
    {
        FlowTemplate.Parse(text, out var problem);

        Assert.NotNull(problem);
    }

    [Fact]
    public void The_literal_text_is_the_template_with_its_placeholders_taken_out() =>
        Assert.Equal("plant//+", FlowTemplate.Parse("plant/{{topic[1]}}/+", out _).LiteralText);

    // A variable's placeholder carries its name and a field's its path, and neither of them is text.
    [Fact]
    public void The_literal_text_leaves_out_a_variable_and_a_field_as_well() =>
        Assert.Equal("plant///+", FlowTemplate.Parse("plant/{{var.site}}/{{$.zone}}/+", out _).LiteralText);

    [Fact]
    public void A_template_with_a_problem_renders_the_text_as_it_was_written()
    {
        var template = FlowTemplate.Parse("{{colour}} {{var.limit}}", out var problem);

        Assert.NotNull(problem);
        Assert.Equal("{{colour}} {{var.limit}}", template.Render(Reading, Variables, T0, new Random(7), FlowLimits.PayloadBytes, out _));
    }

    // A level far along a long topic is read as it is, not as the empty text of a level the split
    // stopped short of.
    [Fact]
    public void A_level_far_along_a_long_topic_is_read_as_it_is()
    {
        var topic = string.Join('/', Enumerable.Range(0, 150).Select(level => $"l{level}"));

        Assert.Equal("l99", Render("{{topic[99]}}", new FlowMessage(topic, "")));
    }

    [Fact]
    public void A_render_writes_no_more_than_its_caller_keeps_and_says_it_cut()
    {
        var template = Parsed(string.Concat(Enumerable.Repeat("{{payload}}", 1_000)));
        var message = new FlowMessage("plant/k1/temp", new string('p', 16 * 1024));
        template.Render(message, Variables, T0, new Random(7), 10, out _);

        var before = GC.GetAllocatedBytesForCurrentThread();
        var rendered = template.Render(message, Variables, T0, new Random(7), FlowLimits.ReasonLength, out var cut);
        var allocated = GC.GetAllocatedBytesForCurrentThread() - before;

        Assert.Equal(new string('p', FlowLimits.ReasonLength), rendered);
        Assert.True(cut);
        Assert.True(allocated < 64 * 1024, $"{allocated:N0} bytes were allocated to render {FlowLimits.ReasonLength} characters.");
    }

    [Fact]
    public void A_render_that_fits_is_not_cut() =>
        Assert.Equal(("k1 at 94.2", false), (Parsed("{{topic[1]}} at {{$.temp}}").Render(Reading, Variables, T0, new Random(7), 10, out var cut), cut));

    // A variable may hold sixty-four kilobytes, and an alarm's reason keeps two hundred characters.
    [Fact]
    public void A_variable_is_cut_to_what_the_caller_keeps_like_any_other_part()
    {
        var big = new Dictionary<string, string> { ["big"] = new string('v', FlowLimits.VariableBytes) };

        var rendered = Parsed("{{var.big}}").Render(Reading, big, T0, new Random(7), FlowLimits.ReasonLength, out var cut);

        Assert.Equal(new string('v', FlowLimits.ReasonLength), rendered);
        Assert.True(cut);
    }

    // The text with no placeholder at all takes a way of its own through Render, and keeps the same rules.
    [Theory]
    [InlineData("abcdef", 6, "abcdef", false)]
    [InlineData("abcdef", 5, "abcde", true)]
    [InlineData("ab\U0001F600c", 3, "ab", true)]
    public void A_text_without_placeholders_is_cut_to_what_the_caller_keeps_too(string text, int most, string expected, bool wasCut)
    {
        var rendered = Parsed(text).Render(Reading, Variables, T0, new Random(7), most, out var cut);

        Assert.Equal(expected, rendered);
        Assert.Equal(wasCut, cut);
    }

    [Fact]
    public void A_cut_never_leaves_half_a_character()
    {
        var rendered = Parsed("{{payload}}").Render(new FlowMessage("a", "ab\U0001F600c"), Variables, T0, new Random(7), 3, out var cut);

        Assert.Equal("ab", rendered);
        Assert.True(cut);
    }

    [Fact]
    public void A_render_reads_its_payload_as_a_document_once_however_many_fields_ask()
    {
        var message = new FlowMessage("plant/k1/temp", "{\"temp\":94.2," + new string(' ', 10_000));

        var one = Readings("{{$.temp}}", message);
        var hundred = Readings(string.Concat(Enumerable.Repeat("{{$.temp}} ", 100)), message);

        Assert.NotEqual(0, one);
        Assert.Equal(one, hundred);
    }

    private static int Readings(string text, FlowMessage message)
    {
        var template = Parsed(text);
        var thread = Environment.CurrentManagedThreadId;
        var thrown = 0;

        void Count(object? sender, FirstChanceExceptionEventArgs args)
        {
            if (args.Exception is JsonException && Environment.CurrentManagedThreadId == thread) thrown++;
        }

        AppDomain.CurrentDomain.FirstChanceException += Count;
        try
        {
            template.Render(message, Variables, T0, new Random(7), FlowLimits.PayloadBytes, out _);
        }
        finally
        {
            AppDomain.CurrentDomain.FirstChanceException -= Count;
        }

        return thrown;
    }
}
