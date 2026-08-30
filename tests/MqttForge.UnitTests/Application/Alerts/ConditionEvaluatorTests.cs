using System.Diagnostics;
using System.Text.RegularExpressions;
using MqttForge.Application.Alerts;
using MqttForge.Application.Alerts.Conditions;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;

namespace MqttForge.UnitTests.Application.Alerts;

public class ConditionEvaluatorTests
{
    private static readonly DateTimeOffset Now = new(2026, 8, 30, 9, 14, 22, TimeSpan.Zero);

    private static EvalContext Arrival(string? text, double? number) =>
        new("plant/boiler/temp", text, number, Now, LastSeen: null, Window: null);

    private static AlertRule RuleWith(AlertCondition condition) =>
        new("r", "rule", Enabled: true, "plant/#", null, condition, null, null, null, AlertSeverity.Warn, []);

    private static ConditionEvaluator EvaluatorFor(params AlertCondition[] conditions) =>
        new(CompiledPatterns.For([.. conditions.Select(RuleWith)]));

    // A rule set with no patterns at all, so any pattern reaching the evaluator would throw —
    // which is what the short-circuit tests below turn into an assertion.
    private static ConditionEvaluator NoPatterns => new(CompiledPatterns.For([]));

    [Theory]
    [InlineData(ThresholdOp.Gt, 90, 95, Verdict.True)]
    [InlineData(ThresholdOp.Gt, 90, 90, Verdict.False)]
    [InlineData(ThresholdOp.Gt, 90, 89.9, Verdict.False)]
    [InlineData(ThresholdOp.Gte, 90, 90, Verdict.True)]
    [InlineData(ThresholdOp.Gte, 90, 89.9, Verdict.False)]
    [InlineData(ThresholdOp.Lt, 90, 89.9, Verdict.True)]
    [InlineData(ThresholdOp.Lt, 90, 90, Verdict.False)]
    [InlineData(ThresholdOp.Lte, 90, 90, Verdict.True)]
    [InlineData(ThresholdOp.Lte, 90, 90.1, Verdict.False)]
    [InlineData(ThresholdOp.Eq, 90, 90, Verdict.True)]
    [InlineData(ThresholdOp.Eq, 90, 90.1, Verdict.False)]
    [InlineData(ThresholdOp.Neq, 90, 90.1, Verdict.True)]
    [InlineData(ThresholdOp.Neq, 90, 90, Verdict.False)]
    public void Threshold_answers_every_operator(ThresholdOp op, double against, double reading, Verdict expected)
    {
        var verdict = NoPatterns.Evaluate(new ThresholdCondition(op, against), Arrival(reading.ToString("R"), reading));

        Assert.Equal(expected, verdict);
    }

    // The spec's flapping signal, at the only three values that decide anything. A condition that
    // answered 90.0 with True would make '> 90' fire on a boiler holding exactly its setpoint.
    [Theory]
    [InlineData(89.9, Verdict.False)]
    [InlineData(90.0, Verdict.False)]
    [InlineData(90.1, Verdict.True)]
    public void The_flapping_signal_is_judged_at_the_edge_and_not_around_it(double reading, Verdict expected)
    {
        var verdict = NoPatterns.Evaluate(new ThresholdCondition(ThresholdOp.Gt, 90), Arrival(reading.ToString("R"), reading));

        Assert.Equal(expected, verdict);
    }

    // The heart of the three-valued verdict. A device saying 'warming up' has not gone below ten.
    [Theory]
    [InlineData("warming up")]
    [InlineData("")]
    [InlineData("on")]
    public void A_body_that_is_not_a_number_is_skipped_and_not_false(string body)
    {
        var verdict = NoPatterns.Evaluate(new ThresholdCondition(ThresholdOp.Lt, 10), Arrival(body, null));

        Assert.Equal(Verdict.Skipped, verdict);
    }

    [Fact]
    public void An_absent_field_is_skipped_and_not_false()
    {
        var verdict = NoPatterns.Evaluate(new ThresholdCondition(ThresholdOp.Lt, 10), Arrival(null, null));

        Assert.Equal(Verdict.Skipped, verdict);
    }

    // Nothing upstream should produce these — asReading's pattern rejects 'NaN' and 'Infinity' —
    // but Neq is the operator that would fire on a NaN if one ever arrived, because every
    // comparison against NaN is false and 'not equal' inherits that. An alert whose reason reads
    // 'NaN != 90' is worse than no alert.
    [Theory]
    [InlineData(double.NaN)]
    [InlineData(double.PositiveInfinity)]
    [InlineData(double.NegativeInfinity)]
    public void A_reading_that_is_not_a_finite_number_is_skipped(double reading)
    {
        var verdict = NoPatterns.Evaluate(new ThresholdCondition(ThresholdOp.Neq, 90), Arrival("x", reading));

        Assert.Equal(Verdict.Skipped, verdict);
    }

    // The 4-20mA line: both ends of the range are in it. A saturated line sitting at exactly 20.0
    // is at the top of its working range, not outside it.
    [Theory]
    [InlineData(4, Verdict.True)]
    [InlineData(12, Verdict.True)]
    [InlineData(20, Verdict.True)]
    [InlineData(3.9999, Verdict.False)]
    [InlineData(20.0001, Verdict.False)]
    public void The_edges_of_a_band_belong_to_its_inside(double reading, Verdict expected)
    {
        var verdict = NoPatterns.Evaluate(new BandCondition(4, 20, Inside: true), Arrival("x", reading));

        Assert.Equal(expected, verdict);
    }

    [Theory]
    [InlineData(4, Verdict.False)]
    [InlineData(12, Verdict.False)]
    [InlineData(20, Verdict.False)]
    [InlineData(3.9999, Verdict.True)]
    [InlineData(20.0001, Verdict.True)]
    public void Outside_is_the_exact_complement_of_inside(double reading, Verdict expected)
    {
        var verdict = NoPatterns.Evaluate(new BandCondition(4, 20, Inside: false), Arrival("x", reading));

        Assert.Equal(expected, verdict);
    }

    // A band written the wrong way round has no inside, and its outside is everything. Reported
    // rather than corrected: silently swapping the edges would make '4..20' and '20..4' the same
    // rule, and the place to refuse a backwards band is the validator, where the user is looking.
    [Theory]
    [InlineData(true, Verdict.False)]
    [InlineData(false, Verdict.True)]
    public void A_band_written_backwards_has_no_inside(bool inside, Verdict expected)
    {
        var verdict = NoPatterns.Evaluate(new BandCondition(20, 4, inside), Arrival("10", 10));

        Assert.Equal(expected, verdict);
    }

    [Fact]
    public void A_band_with_nothing_to_measure_is_skipped()
    {
        var verdict = NoPatterns.Evaluate(new BandCondition(4, 20, Inside: true), Arrival("open", null));

        Assert.Equal(Verdict.Skipped, verdict);
    }

    // Ordinal and untrimmed. A device that sends 'ON' is not sending 'on', and deciding they are
    // the same would make an allow-list quietly permissive about a payload nobody wrote.
    [Theory]
    [InlineData("on", Verdict.True)]
    [InlineData("off", Verdict.True)]
    [InlineData("ON", Verdict.False)]
    [InlineData("on ", Verdict.False)]
    [InlineData("", Verdict.False)]
    public void OneOf_reads_the_text_exactly(string body, Verdict expected)
    {
        var verdict = NoPatterns.Evaluate(new OneOfCondition(["on", "off"], Negate: false), Arrival(body, null));

        Assert.Equal(expected, verdict);
    }

    [Theory]
    [InlineData("on", Verdict.False)]
    [InlineData("maintenance", Verdict.True)]
    public void A_negated_oneOf_fires_on_anything_unlisted(string body, Verdict expected)
    {
        var verdict = NoPatterns.Evaluate(new OneOfCondition(["on", "off"], Negate: true), Arrival(body, null));

        Assert.Equal(expected, verdict);
    }

    // An empty allow-list permits nothing and an empty deny-list forbids nothing. Degenerate, but
    // it is one delete key away in the editor and both answers have to be the boring one.
    [Theory]
    [InlineData(false, Verdict.False)]
    [InlineData(true, Verdict.True)]
    public void An_empty_oneOf_allows_nothing_and_forbids_nothing(bool negate, Verdict expected)
    {
        var verdict = NoPatterns.Evaluate(new OneOfCondition([], negate), Arrival("on", null));

        Assert.Equal(expected, verdict);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void OneOf_on_an_absent_field_is_skipped(bool negate)
    {
        var verdict = NoPatterns.Evaluate(new OneOfCondition(["on"], negate), Arrival(null, null));

        Assert.Equal(Verdict.Skipped, verdict);
    }

    [Theory]
    [InlineData("ERR-17", false, Verdict.True)]
    [InlineData("ERR-17", true, Verdict.False)]
    [InlineData("all good", false, Verdict.False)]
    [InlineData("all good", true, Verdict.True)]
    public void A_pattern_and_its_negation_are_mirrors(string body, bool negate, Verdict expected)
    {
        var condition = new PatternCondition("^ERR-", negate);

        Assert.Equal(expected, EvaluatorFor(condition).Evaluate(condition, Arrival(body, null)));
    }

    // The single most important line in this file. A missing field is not 'the text failed to
    // match'; a rule reading 'body does not contain OK' would otherwise fire on every message
    // whose field is absent, which is every message from a device that formats its JSON slightly
    // differently — a storm about nothing, forever.
    [Fact]
    public void A_negated_pattern_on_an_absent_field_is_skipped_and_not_true()
    {
        var condition = new PatternCondition("^ERR-", Negate: true);

        Assert.Equal(Verdict.Skipped, EvaluatorFor(condition).Evaluate(condition, Arrival(null, null)));
    }

    [Fact]
    public void All_of_nothing_is_true_and_any_of_nothing_is_false()
    {
        Assert.Equal(Verdict.True, NoPatterns.Evaluate(new AllCondition([]), Arrival(null, null)));
        Assert.Equal(Verdict.False, NoPatterns.Evaluate(new AnyCondition([]), Arrival(null, null)));
    }

    // Short-circuiting, asserted rather than described: the second child is a pattern that was
    // never compiled, so reaching it throws. The control test below evaluates the same tree with
    // a reading that does NOT decide it, and gets the throw — which is what makes these two a
    // proof and not a coincidence.
    [Fact]
    public void All_stops_at_the_first_false()
    {
        var tree = new AllCondition([
            new ThresholdCondition(ThresholdOp.Gt, 90),
            new PatternCondition("^ERR-", Negate: false)
        ]);

        Assert.Equal(Verdict.False, NoPatterns.Evaluate(tree, Arrival("10", 10)));
    }

    [Fact]
    public void Any_stops_at_the_first_true()
    {
        var tree = new AnyCondition([
            new ThresholdCondition(ThresholdOp.Gt, 90),
            new PatternCondition("^ERR-", Negate: false)
        ]);

        Assert.Equal(Verdict.True, NoPatterns.Evaluate(tree, Arrival("95", 95)));
    }

    [Fact]
    public void The_child_after_the_deciding_one_really_would_have_been_evaluated()
    {
        var tree = new AllCondition([
            new ThresholdCondition(ThresholdOp.Gt, 90),
            new PatternCondition("^ERR-", Negate: false)
        ]);

        Assert.Throws<KeyNotFoundException>(() => NoPatterns.Evaluate(tree, Arrival("95", 95)));
    }

    // Precedence, which is where the three-valued logic earns its keep. A composite whose one
    // readable child says no is a no; a composite with nothing readable is not a no.
    [Fact]
    public void All_is_false_when_a_child_is_false_even_though_another_was_skipped()
    {
        var tree = new AllCondition([
            new ThresholdCondition(ThresholdOp.Gt, 100),
            new OneOfCondition(["on"], Negate: false)
        ]);

        Assert.Equal(Verdict.False, NoPatterns.Evaluate(tree, Arrival(null, 95)));
    }

    [Fact]
    public void All_is_skipped_when_no_child_is_false_and_one_was_skipped()
    {
        var tree = new AllCondition([
            new ThresholdCondition(ThresholdOp.Gt, 90),
            new OneOfCondition(["on"], Negate: false)
        ]);

        Assert.Equal(Verdict.Skipped, NoPatterns.Evaluate(tree, Arrival(null, 95)));
    }

    [Fact]
    public void Any_is_true_when_a_child_is_true_even_though_another_was_skipped()
    {
        var tree = new AnyCondition([
            new OneOfCondition(["on"], Negate: false),
            new ThresholdCondition(ThresholdOp.Gt, 90)
        ]);

        Assert.Equal(Verdict.True, NoPatterns.Evaluate(tree, Arrival(null, 95)));
    }

    [Fact]
    public void Any_is_skipped_when_no_child_is_true_and_one_was_skipped()
    {
        var tree = new AnyCondition([
            new OneOfCondition(["on"], Negate: false),
            new ThresholdCondition(ThresholdOp.Gt, 100)
        ]);

        Assert.Equal(Verdict.Skipped, NoPatterns.Evaluate(tree, Arrival(null, 95)));
    }

    [Theory]
    [InlineData("20", 20d, Verdict.True)]
    [InlineData("19.9", 19.9d, Verdict.False)]
    [InlineData("open", null, Verdict.Skipped)]
    public void Three_deep_carries_the_verdict_all_the_way_up(string body, double? number, Verdict expected)
    {
        var tree = new AllCondition([
            new AnyCondition([
                new AllCondition([new ThresholdCondition(ThresholdOp.Gte, 20)])
            ])
        ]);

        Assert.Equal(expected, NoPatterns.Evaluate(tree, Arrival(body, number)));
    }

    // The user's pattern runs on the message path, so one that backtracks for ever is a pump that
    // stops for ever. It is cut off — and the exception is let out, because "nobody found out" and
    // "the field was missing" have to stay different facts one level up. This method's only way of
    // saying 'I ran out of time' would be Verdict.Skipped, which is exactly what an absent field
    // answers, and final task 14 has to be able to tell them apart: ten timeouts in a row is a rule
    // spending half a second of a single-threaded engine per message. The engine is what turns this
    // into a skip, and what counts it.
    [Fact]
    public void A_catastrophic_pattern_is_cut_short_rather_than_answered()
    {
        var condition = new PatternCondition(HostilePatterns.Catastrophic, Negate: false);
        var evaluator = EvaluatorFor(condition);
        var hostile = Arrival(HostilePatterns.Payload, null);

        var clock = Stopwatch.StartNew();
        Assert.Throws<RegexMatchTimeoutException>(() => evaluator.Evaluate(condition, hostile));
        clock.Stop();

        // Ten times the 50ms budget. The number being asserted is 'it stopped', not 'it stopped in
        // exactly 50ms' — a loaded machine is allowed to be slow, an unbounded one is not.
        Assert.True(clock.ElapsedMilliseconds < 500, $"took {clock.ElapsedMilliseconds}ms");
    }

    // Silence is a fact about time passing, settled by the tick, and the tick does not exist yet.
    // Skipped rather than a throw so a rule set carrying one is loadable now and the rule is merely
    // quiet rather than Faulted. Final task 10 replaces both the arm and this test, with one that
    // measures the gap from LastSeen and one that keeps a never-heard-from pair Skipped.

        [Theory]
        [InlineData(59, Verdict.False)]
        [InlineData(60, Verdict.True)]
        public void Silence_is_measured_from_when_the_topic_last_spoke(int seconds, Verdict expected)
        {
            var context = new EvalContext("plant/boiler/temp", null, null, Now,
                LastSeen: Now.AddSeconds(-seconds), Window: null);

            Assert.Equal(expected, NoPatterns.Evaluate(new SilenceCondition(60), context));
        }

        [Fact]
        public void A_topic_that_has_never_been_heard_from_is_skipped_rather_than_called_silent()
        {
            Assert.Equal(Verdict.Skipped, NoPatterns.Evaluate(new SilenceCondition(60), Arrival("x", null)));
        }
}
