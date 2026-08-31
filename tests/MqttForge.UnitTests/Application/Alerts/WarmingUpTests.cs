using MqttForge.Application.Alerts;
using MqttForge.Application.Alerts.Statistics;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;

namespace MqttForge.UnitTests.Application.Alerts;

/// <summary>
/// A statistical rule is quiet for its first twenty readings and that has to be visible.
///
/// This is the one failure mode the spec calls out by name: a rule that has been saved, matches a
/// topic, is receiving messages and is correctly saying nothing looks exactly like a rule that is
/// broken. The panel gets a row per pair — how many readings it has of the twenty it needs — and
/// the row disappears of its own accord the moment the pair can be judged.
/// </summary>
public class WarmingUpTests
{
    private static AlertEngineCore Core(AlertCondition condition) =>
        AlertEngineFixture.Core(AlertEngineFixture.Rule(condition));

    // The gate and the smallest window a rule may ask for are the same twenty, and they are
    // written down in two places — the engine's options and the statistics. Nothing but this stops
    // them drifting, and a pair warming to a number no rule could have asked for is nonsense.
    [Fact]
    public void The_warm_up_target_is_the_smallest_window_a_rule_may_ask_for()
    {
        Assert.Equal(Statistical.EnoughToJudge, new AlertEngineOptions().MinWindow);
    }

    [Fact]
    public void A_pair_short_of_its_minimum_says_how_far_along_it_is()
    {
        var core = Core(new DistributionShiftCondition(200));

        Streams.Feed(core, Enumerable.Range(0, 7).Select(i => 20d + i * 0.1),
                     AlertEngineFixture.T0, TimeSpan.FromSeconds(1));

        var warming = Assert.Single(core.Snapshot().Warming);

        Assert.Equal(AlertEngineFixture.Topic, warming.Topic);
        Assert.Equal(7, warming.Have);
        Assert.Equal(20, warming.Need);
    }

    [Fact]
    public void A_pair_that_has_filled_its_minimum_stops_being_listed()
    {
        var core = Core(new OutlierCondition(OutlierMethod.Tukey, 1.5, 200));

        Streams.Feed(core, Enumerable.Range(0, 20).Select(i => 20d + i % 5 * 0.1),
                     AlertEngineFixture.T0, TimeSpan.FromSeconds(1));

        Assert.Empty(core.Snapshot().Warming);
    }

    // A threshold rule is never warming up: it judges the message in hand and holds no history, so
    // a row saying it is filling a window would be a row about something that is not happening.
    [Fact]
    public void A_rule_that_reads_no_history_is_never_warming_up()
    {
        var core = Core(new ThresholdCondition(ThresholdOp.Gt, 90));

        Streams.Feed(core, [1d, 2d, 3d], AlertEngineFixture.T0, TimeSpan.FromSeconds(1));

        Assert.Empty(core.Snapshot().Warming);
    }

    // Buried in a composite, the pair still needs its window and the row still has to appear —
    // otherwise the one rule shape that mixes a cheap clause with an expensive one is the shape
    // that goes unexplained.
    [Fact]
    public void A_statistical_condition_inside_a_composite_still_warms_up()
    {
        var core = Core(new AnyCondition([
            new ThresholdCondition(ThresholdOp.Gt, 900),
            new ShapeChangeCondition(200)
        ]));

        Streams.Feed(core, Enumerable.Range(0, 5).Select(i => (double)i),
                     AlertEngineFixture.T0, TimeSpan.FromSeconds(1));

        Assert.Equal(5, Assert.Single(core.Snapshot().Warming).Have);
    }
}
