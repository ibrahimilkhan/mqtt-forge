using MqttForge.Application.Alerts.Conditions;
using MqttForge.Application.Flows;

namespace MqttForge.UnitTests.Application.Flows;

public class IfTestTests
{
    [Theory]
    [InlineData("gt", "94.2", "90", true)]
    [InlineData("gt", "90", "90", false)]
    [InlineData("gte", "90", "90", true)]
    [InlineData("lt", "10", "90", true)]
    [InlineData("lt", "90", "90", false)]
    [InlineData("lte", "90.0", "90", true)]
    [InlineData("lte", "91", "90", false)]
    public void Compare_reads_both_sides_as_numbers(string op, string text, string value, bool yes) =>
        Assert.Equal(yes, new CompareTest(op).Judge(text, value, ""));

    // The compiler builds a compare for those four ops and for no other, so any other is a mistake in
    // the code that built it, and a mistake is not answered as if it were lte.
    [Theory]
    [InlineData("eq")]
    [InlineData("GT")]
    [InlineData("")]
    public void An_op_that_is_not_a_comparison_is_a_mistake_and_not_an_answer(string op) =>
        Assert.Throws<ArgumentOutOfRangeException>(() => new CompareTest(op).Judge("94", "90", ""));

    // A run always decides. A missing field, or a reading that is not a number, is "no".
    [Fact]
    public void A_missing_field_or_a_word_is_no()
    {
        Assert.False(new CompareTest("gt").Judge(null, "90", ""));
        Assert.False(new CompareTest("lt").Judge("warming up", "90", ""));
    }

    // What the field is compared with comes from the node — a typed number, or a variable's value —
    // and when that is not a number, it is the step that cannot do its job.
    [Fact]
    public void A_value_that_is_not_a_number_is_the_steps_failure()
    {
        var failure = Assert.Throws<FlowStepException>(() => new CompareTest("gt").Judge("94", "ninety", ""));

        Assert.Contains("ninety", failure.Message);
    }

    // The step cannot do its job whatever the message holds, so it says so before it looks at the
    // message: a variable that holds "ninety" must not wait for a message that carries the field.
    [Fact]
    public void A_value_that_is_not_a_number_fails_the_step_whether_or_not_the_field_is_there()
    {
        Assert.Throws<FlowStepException>(() => new CompareTest("gt").Judge(null, "ninety", ""));
        Assert.Throws<FlowStepException>(() => new BetweenTest().Judge(null, "low", "90"));
        Assert.Throws<FlowStepException>(() => new BetweenTest().Judge("warming up", "90", "80"));
    }

    // A variable may hold sixty-four kilobytes, and what it holds goes into a sentence on the node.
    [Fact]
    public void A_long_value_is_quoted_cut_short_in_the_failure()
    {
        var failure = Assert.Throws<FlowStepException>(() => new CompareTest("gt").Judge("94", new string('x', 500), ""));

        Assert.Contains(new string('x', 40) + "'", failure.Message);
        Assert.DoesNotContain(new string('x', 41), failure.Message);
    }

    // So may a pattern, and the parser's own message for one that does not compile quotes it whole.
    [Fact]
    public void A_long_pattern_that_does_not_compile_is_quoted_cut_short_in_the_failure()
    {
        var pattern = "(" + new string('x', FlowLimits.VariableBytes);

        var failure = Assert.Throws<FlowStepException>(() => new MatchesTest(null).Judge("x", pattern, ""));

        Assert.Contains("'(" + new string('x', 39) + "'", failure.Message);
        Assert.DoesNotContain(new string('x', 40), failure.Message);
        Assert.True(failure.Message.Length < 200, $"The failure is {failure.Message.Length:N0} characters long.");
    }

    [Fact]
    public void Equals_is_numeric_when_both_sides_are_numbers_and_text_otherwise()
    {
        Assert.True(new EqualsTest(negate: false).Judge("90.0", "90", ""));
        Assert.True(new EqualsTest(negate: false).Judge("on", "on", ""));
        Assert.False(new EqualsTest(negate: false).Judge("On", "on", ""));
        Assert.True(new EqualsTest(negate: true).Judge("off", "on", ""));
    }

    [Fact]
    public void A_missing_field_is_no_for_equals_and_for_not_equals_alike()
    {
        Assert.False(new EqualsTest(negate: false).Judge(null, "on", ""));
        Assert.False(new EqualsTest(negate: true).Judge(null, "on", ""));
    }

    [Fact]
    public void Between_includes_both_ends_and_wants_them_in_order()
    {
        Assert.True(new BetweenTest().Judge("80", "80", "90"));
        Assert.True(new BetweenTest().Judge("90", "80", "90"));
        Assert.False(new BetweenTest().Judge("90.1", "80", "90"));
        Assert.Throws<FlowStepException>(() => new BetweenTest().Judge("85", "90", "80"));
        Assert.Throws<FlowStepException>(() => new BetweenTest().Judge("85", "low", "90"));
    }

    // Wanting them in order is not wanting them apart: one number for both ends is a test for that number.
    [Fact]
    public void Between_may_name_one_number_for_both_ends()
    {
        Assert.True(new BetweenTest().Judge("90", "90", "90"));
        Assert.False(new BetweenTest().Judge("91", "90", "90"));
    }

    [Fact]
    public void Matches_uses_the_pattern_it_was_compiled_with_or_the_one_it_is_given()
    {
        Assert.True(new MatchesTest(CompiledPatterns.Compile("^warn")).Judge("warning", "ignored", ""));
        Assert.True(new MatchesTest(null).Judge("warning", "^warn", ""));
        Assert.False(new MatchesTest(null).Judge(null, "^warn", ""));
        Assert.Throws<FlowStepException>(() => new MatchesTest(null).Judge("x", "(", ""));
    }

    // A pattern held in a variable can change between two messages, and the one kept from the last
    // message must not be the one that decides the next.
    [Fact]
    public void Matches_compiles_again_when_the_pattern_it_is_given_changes()
    {
        var test = new MatchesTest(null);

        Assert.True(test.Judge("warning", "^warn", ""));
        Assert.False(test.Judge("warning", "^cold", ""));
        Assert.True(test.Judge("cold front", "^cold", ""));
        Assert.True(test.Judge("warning", "^warn", ""));
    }

    [Fact]
    public void One_of_reads_its_list_each_time_and_trims_it()
    {
        Assert.True(new OneOfTest().Judge("off", "on, off", ""));
        Assert.False(new OneOfTest().Judge("idle", "on, off", ""));
        Assert.False(new OneOfTest().Judge(null, "on, off", ""));
    }

    // A stray comma is not an item: an empty reading is not "one of" a list that holds nothing.
    [Fact]
    public void One_of_does_not_count_the_empty_items_of_its_list()
    {
        Assert.False(new OneOfTest().Judge("", "on,,off", ""));
        Assert.False(new OneOfTest().Judge("", "", ""));
    }

    [Fact]
    public void Exists_asks_only_whether_the_field_is_there()
    {
        Assert.True(new ExistsTest().Judge("", "", ""));
        Assert.False(new ExistsTest().Judge(null, "", ""));
    }
}
