using System.Globalization;
using MqttForge.Application.Alerts;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;

namespace MqttForge.UnitTests.Application.Alerts;

/// <summary>
/// What a rule's ring costs, and who decides it.
///
/// One promise: a rule that asks to be judged on N readings gets a ring of N readings, and the
/// budget that bounds the engine's memory is charged for N. Before this the ring was always
/// DefaultWindow, so a rule asking for two thousand was silently judged on two hundred and the
/// budget was told it had spent two hundred — a disagreement nobody could see from the panel and
/// nobody could see from the rule.
///
/// Every number below is read off the panel's own diagnostics rather than out of the engine's
/// insides, because those diagnostics are the only thing anybody can see, and a promise nobody
/// can check on a running system is not a promise. With a budget of exactly N readings, the
/// number of pairs that fit is what each of them cost.
/// </summary>
public class WindowPlanTests
{
    private static readonly DateTimeOffset T0 = new(2026, 8, 30, 9, 0, 0, TimeSpan.Zero);

    private static AlertRule Rule(string id, AlertCondition condition, string filter = "line/+/mA") =>
        new(id, $"Rule {id}", Enabled: true, filter, Field: null, condition, Clear: null,
            For: null, Cooldown: 0, AlertSeverity.Warn, [new ScreenAction()]);

    private static AlertEngineCore Engine(AlertEngineOptions options, params AlertRule[] rules)
    {
        var engine = new AlertEngineCore(options);
        engine.SetRules(rules, T0);
        return engine;
    }

    private static MqttMessage Msg(string topic, double value, DateTimeOffset at) =>
        new(topic, value.ToString(CultureInfo.InvariantCulture), "text", Qos: 0, Retain: false,
            ReceivedAt: at);

    // The one that is red before this task. All three conditions in one test rather than three
    // tests, because the mistake this catches is a case missing from a switch, and a switch loses
    // its cases one at a time.
    [Fact]
    public void Each_of_the_three_statistical_conditions_sizes_the_ring_too()
    {
        AlertCondition[] asking =
        [
            new DistributionShiftCondition(Window: 2_000),
            new ShapeChangeCondition(Window: 2_000),
            new PulseCondition(PulseMetric.Count, ThresholdOp.Gt, 3, Window: 2_000),
        ];

        foreach (var condition in asking)
        {
            var engine = Engine(new AlertEngineOptions { MaxReadings = 2_000 }, Rule("r1", condition));

            engine.OnMessage(Msg("line/0/mA", 4.0, T0), T0);
            engine.OnMessage(Msg("line/1/mA", 4.0, T0), T0);

            // One pair fills the whole budget, exactly as the outlier below does. A fit taken over
            // two hundred readings and a fit taken over two thousand are different claims about a
            // machine, and a rule that asked for the second one must not quietly be given the
            // first — nor must the budget be told a two-thousand-reading rule costs two hundred.
            var snapshot = engine.Snapshot();
            Assert.Equal(1, snapshot.Rules.Single().Topics);
            Assert.Equal(1, Assert.Single(snapshot.Capped).Untracked);
        }
    }

    [Fact]
    public void A_condition_asking_for_two_thousand_readings_gets_a_ring_of_two_thousand()
    {
        var options = new AlertEngineOptions { MaxReadings = 2_000 };
        var engine = Engine(options, Rule("r1", new OutlierCondition(OutlierMethod.Tukey, K: 0, Window: 2_000)));

        engine.OnMessage(Msg("line/0/mA", 4.0, T0), T0);
        engine.OnMessage(Msg("line/1/mA", 4.0, T0), T0);

        // One pair fills the whole budget. Before task 5 the same rule would have been given two
        // hundred readings, ten pairs would have fitted, and the rule would have been judged on a
        // tenth of the history it asked for without a word to anybody.
        var snapshot = engine.Snapshot();
        Assert.Equal(1, snapshot.Rules.Single().Topics);
        Assert.Equal(1, Assert.Single(snapshot.Capped).Untracked);
    }

    [Fact]
    public void Two_windowed_conditions_on_one_rule_get_the_larger_ring()
    {
        var options = new AlertEngineOptions { MaxReadings = 1_600 };
        var engine = Engine(options, Rule("r1", new AnyCondition([
            new OutlierCondition(OutlierMethod.Tukey, K: 0, Window: 50),
            new OutlierCondition(OutlierMethod.Sigma, K: 0, Window: 800)
        ])));

        for (var i = 0; i < 3; i++)
            engine.OnMessage(Msg($"line/{i}/mA", 4.0, T0), T0);

        // Eight hundred each, so two fit and the third does not. Had the ring been sized from the
        // first condition the walk met, or from the smallest, thirty-two would have fitted and
        // the eight-hundred condition would have been judged on fifty readings.
        var snapshot = engine.Snapshot();
        Assert.Equal(2, snapshot.Rules.Single().Topics);
        Assert.Equal(1, Assert.Single(snapshot.Capped).Untracked);
    }

    [Fact]
    public void A_window_beyond_the_ceiling_is_clamped_to_the_ceiling()
    {
        var options = new AlertEngineOptions { MaxReadings = 2_000 };
        var engine = Engine(options, Rule("r1", new OutlierCondition(OutlierMethod.Tukey, K: 0, Window: 5_000)));

        engine.OnMessage(Msg("line/0/mA", 4.0, T0), T0);
        engine.OnMessage(Msg("line/1/mA", 4.0, T0), T0);

        // Two thousand and not five: the clamp is what makes the ring budget a bound rather than
        // a suggestion, and a rule file edited by hand never met the validator.
        Assert.Equal(1, engine.Snapshot().Rules.Single().Topics);
    }

    [Fact]
    public void A_window_below_the_floor_is_lifted_to_the_floor()
    {
        var options = new AlertEngineOptions { MaxReadings = 200 };
        var engine = Engine(options, Rule("r1", new OutlierCondition(OutlierMethod.Tukey, K: 0, Window: 5)));

        for (var i = 0; i < 11; i++)
            engine.OnMessage(Msg($"line/{i}/mA", 4.0, T0), T0);

        // Twenty readings each, so ten fit. A rule asking for five is judged on twenty rather
        // than never judged at all — the same lift Outlier.SampleOf applies when it draws the
        // fence, and the two have to agree or the budget would be paying for readings nothing
        // reads.
        var snapshot = engine.Snapshot();
        Assert.Equal(10, snapshot.Rules.Single().Topics);
        Assert.Equal(1, Assert.Single(snapshot.Capped).Untracked);
    }

    [Fact]
    public void A_rule_with_no_windowed_condition_still_gets_the_default_window()
    {
        var options = new AlertEngineOptions { MaxReadings = 2_000 };
        var engine = Engine(options, Rule("r1", new ThresholdCondition(ThresholdOp.Gt, 19.0)));

        for (var i = 0; i < 11; i++)
            engine.OnMessage(Msg($"line/{i}/mA", 4.0, T0), T0);

        // Two hundred each, ten pairs, one refused: exactly what this engine did before any of
        // this plan existed. Sizing the ring from the rule must not have quietly changed what a
        // rule set of plain thresholds costs.
        var snapshot = engine.Snapshot();
        Assert.Equal(10, snapshot.Rules.Single().Topics);
        Assert.Equal(1, Assert.Single(snapshot.Capped).Untracked);
    }

    [Fact]
    public void A_refused_pair_is_never_evaluated_and_is_counted_once()
    {
        var options = new AlertEngineOptions { MaxReadings = 2_000 };
        var engine = Engine(options, Rule("r1", new OutlierCondition(OutlierMethod.Tukey, K: 0, Window: 2_000)));

        engine.OnMessage(Msg("line/0/mA", 4.0, T0), T0);

        for (var i = 0; i < 20; i++)
        {
            var at = T0.AddSeconds(i + 1);
            engine.OnMessage(Msg("line/1/mA", 4.0, at), at);
        }

        var snapshot = engine.Snapshot();

        // One topic watched, one refused, and the refused one counted once however often it
        // arrives — a single chatty device the budget could not house is one untracked topic, not
        // twenty. Its messages are not judged at all: a refused pair is not a pair that answers
        // cheaply.
        Assert.Equal(1, snapshot.Rules.Single().Topics);

        // Skipped and not Evaluated: the ring is written after the judgement, so the very first
        // message on a pair is judged against an empty window and answers 'not enough run yet'.
        Assert.Equal(0L, snapshot.Rules.Single().Evaluated);
        Assert.Equal(1L, snapshot.Rules.Single().Skipped);

        Assert.Equal(1, Assert.Single(snapshot.Capped).Untracked);
    }
}
