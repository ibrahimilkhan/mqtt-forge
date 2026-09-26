using System.Globalization;
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
        return template.Render(message ?? Reading, T0, new Random(seed));
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
}
