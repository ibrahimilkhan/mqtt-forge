using System.Globalization;
using System.Runtime.ExceptionServices;
using System.Text.Json;
using MqttForge.Application.Flows;

namespace MqttForge.UnitTests.Application.Flows;

public class FlowTemplateTests
{
    private static readonly DateTimeOffset T0 = new(2026, 9, 26, 9, 14, 22, 104, TimeSpan.Zero);

    private static readonly FlowMessage Reading =
        new("plant/k1/temp", "{\"temp\":94.2,\"fan\":\"off\"}", Index: 3);

    private static string Render(string text, FlowMessage? message = null, int seed = 7)
    {
        var template = FlowTemplate.Parse(text, out var problem);
        Assert.Null(problem);

        var rendered = template.Render(message ?? Reading, T0, new Random(seed), FlowLimits.PayloadBytes, out var cut);
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
    public void Each_placeholder_fills_in_what_the_spec_says(string text, string expected) =>
        Assert.Equal(expected, Render(text));

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

    [Theory]
    [InlineData("{{colour}}")]
    [InlineData("{{topic[x]}}")]
    [InlineData("{{random(95,80)}}")]
    [InlineData("{{random(a,b)}}")]
    [InlineData("{{topic")]
    public void What_a_template_cannot_fill_in_is_a_problem(string text)
    {
        FlowTemplate.Parse(text, out var problem);

        Assert.NotNull(problem);
    }

    [Fact]
    public void The_literal_text_is_the_template_with_its_placeholders_taken_out()
    {
        var template = FlowTemplate.Parse("plant/{{topic[1]}}/+", out _);

        Assert.Equal("plant//+", template.LiteralText);
    }

    // ---- what one render may cost ----

    // A thousand copies of a 16 KB payload is sixteen million characters, and the caller keeps two
    // hundred of them. Nothing past what is kept may be built: the allocation is the proof, since
    // the text that comes back would be the same either way.
    [Fact]
    public void A_render_writes_no_more_than_its_caller_keeps_and_says_it_cut()
    {
        var template = Parsed(string.Concat(Enumerable.Repeat("{{payload}}", 1_000)));
        var message = new FlowMessage("plant/k1/temp", new string('p', 16 * 1024));
        template.Render(message, T0, new Random(7), 10, out _);

        var before = GC.GetAllocatedBytesForCurrentThread();
        var rendered = template.Render(message, T0, new Random(7), FlowLimits.ReasonLength, out var cut);
        var allocated = GC.GetAllocatedBytesForCurrentThread() - before;

        Assert.Equal(new string('p', FlowLimits.ReasonLength), rendered);
        Assert.True(cut);
        Assert.True(allocated < 64 * 1024, $"{allocated:N0} bytes were allocated to render {FlowLimits.ReasonLength} characters.");
    }

    [Fact]
    public void A_render_that_fits_is_not_cut() =>
        Assert.Equal(("k1 at 94.2", false), (Parsed("{{topic[1]}} at {{$.temp}}").Render(Reading, T0, new Random(7), 10, out var cut), cut));

    [Fact]
    public void A_cut_never_leaves_half_a_character()
    {
        // The face is two UTF-16 units; three characters' room would split it.
        var rendered = Parsed("{{payload}}").Render(new FlowMessage("a", "ab\U0001F600c"), T0, new Random(7), 3, out var cut);

        Assert.Equal("ab", rendered);
        Assert.True(cut);
    }

    // A payload that opens as a document and is not one ends every reading of it in a JsonException
    // — thrown and passed on inside the parser, so several to a reading — and the exceptions a render
    // throws count the times it read the payload.
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
            template.Render(message, T0, new Random(7), FlowLimits.PayloadBytes, out _);
        }
        finally
        {
            AppDomain.CurrentDomain.FirstChanceException -= Count;
        }

        return thrown;
    }

    [Fact]
    public void A_level_far_along_a_long_topic_is_read_as_it_is()
    {
        var topic = string.Join('/', Enumerable.Range(0, 150).Select(level => $"l{level}"));

        Assert.Equal("l99", Render("{{topic[99]}}", new FlowMessage(topic, "")));
    }
}
