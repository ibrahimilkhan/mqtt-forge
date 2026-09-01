using MqttForge.Api.Contracts;
using MqttForge.Api.Validation;

namespace MqttForge.UnitTests.Api;

public class ColourRulesDtoValidatorTests
{
    private readonly ColourRulesDtoValidator _validator = new();

    private bool IsValid(params ColourRuleDto[] rules) => _validator.Validate(new ColourRulesDto(rules)).IsValid;

    [Fact]
    public void An_empty_list_is_valid()
    {
        Assert.True(IsValid());
    }

    [Theory]
    [InlineData("sensors/temp")]
    [InlineData("sensors/+/temp")]
    [InlineData("sensors/#")]
    [InlineData("#")]
    [InlineData("+")]
    [InlineData("+/+/+")]
    [InlineData("sensors/+/#")]
    // An empty segment is legal MQTT: 'a//b' has three levels, the middle one empty.
    [InlineData("a//b")]
    public void Accepts_a_well_formed_filter(string filter)
    {
        Assert.True(IsValid(new ColourRuleDto(filter, "#b45309")));
    }

    [Theory]
    [InlineData("")]
    [InlineData("a/#/b")]      // '#' must be last
    [InlineData("#/a")]
    [InlineData("a/b#")]       // '#' must be the whole segment
    [InlineData("a/#b")]
    [InlineData("a/b+")]       // '+' must be the whole segment
    [InlineData("a/+b")]
    [InlineData("sport+/x")]
    [InlineData("a/\0/b")]     // NUL is forbidden in a topic filter
    public void Refuses_a_malformed_filter(string filter)
    {
        Assert.False(IsValid(new ColourRuleDto(filter, "#b45309")));
    }

    [Theory]
    [InlineData("#b45309")]
    [InlineData("#B45309")]
    [InlineData("#000000")]
    [InlineData("#ffffff")]
    public void Accepts_a_six_digit_hex_colour(string colour)
    {
        Assert.True(IsValid(new ColourRuleDto("sensors/#", colour)));
    }

    // The colour reaches an inline style attribute in the browser, so anything that is not
    // exactly a hex triple is refused here rather than sanitised there.
    [Theory]
    [InlineData("")]
    [InlineData("red")]
    [InlineData("#fff")]
    [InlineData("#gggggg")]
    [InlineData("#b45309ff")]
    [InlineData("b45309")]
    [InlineData("rgb(1,2,3)")]
    [InlineData("#b45309; background: url(x)")]
    [InlineData(" #b45309")]
    [InlineData("#b45309 ")]
    public void Refuses_anything_that_is_not_a_hex_triple(string colour)
    {
        Assert.False(IsValid(new ColourRuleDto("sensors/#", colour)));
    }

    // The second colour is the one a rule is allowed not to have: a rule that paints the topic
    // and leaves the payload in the console's ink is the commonest rule there is, and every rule
    // written before the second colour existed is one of them.
    [Fact]
    public void A_rule_may_carry_no_body_colour()
    {
        Assert.True(IsValid(new ColourRuleDto("sensors/#", "#b45309", null)));
    }

    [Theory]
    [InlineData("#b45309")]
    [InlineData("#B45309")]
    [InlineData("#000000")]
    public void Accepts_a_hex_triple_for_the_body(string colour)
    {
        Assert.True(IsValid(new ColourRuleDto("sensors/#", "#1e40af", colour)));
    }

    // Absent is allowed; malformed is not. It reaches the same style attribute as the first one.
    [Theory]
    [InlineData("")]
    [InlineData("red")]
    [InlineData("#fff")]
    [InlineData("#b45309; background: url(x)")]
    public void Refuses_a_body_colour_that_is_not_a_hex_triple(string colour)
    {
        Assert.False(IsValid(new ColourRuleDto("sensors/#", "#1e40af", colour)));
    }

    // Swallowing one of them silently would leave the user unable to explain why the rule
    // they typed does nothing.
    [Fact]
    public void Refuses_the_same_filter_twice()
    {
        Assert.False(IsValid(
            new ColourRuleDto("sensors/#", "#b45309"),
            new ColourRuleDto("sensors/#", "#1e40af")));
    }

    [Fact]
    public void Two_rules_differing_only_in_colour_case_are_still_distinct_filters()
    {
        Assert.True(IsValid(
            new ColourRuleDto("sensors/#", "#b45309"),
            new ColourRuleDto("alerts/#", "#B45309")));
    }

    [Fact]
    public void Accepts_a_hundred_rules()
    {
        var rules = Enumerable.Range(0, 100).Select(i => new ColourRuleDto($"topic/{i}", "#1e40af")).ToArray();

        Assert.True(IsValid(rules));
    }

    [Fact]
    public void Refuses_more_than_a_hundred_rules()
    {
        var rules = Enumerable.Range(0, 101).Select(i => new ColourRuleDto($"topic/{i}", "#1e40af")).ToArray();

        Assert.False(IsValid(rules));
    }
}
