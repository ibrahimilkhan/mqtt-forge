using MqttForge.Application.Alerts;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;

namespace MqttForge.UnitTests.Application.Alerts;

/// <summary>
/// A rhythm, measured. Four numbers about a signal that has events on it: how many, how much of
/// the run they take up, how often they come and how long they last.
///
/// The three things pinned here are the three the units get wrong. A period is milliseconds, so a
/// pump that used to cycle every two seconds and now cycles every eight is a rule about time. A
/// duty is a share of the READINGS, so a signal whose events are rare but long-lived does not
/// report itself as busy. And a metric that does not exist yet is Skipped, never false — 'no
/// period' is not 'a short period', and a rule reading it as one fires on every sensor that has
/// only ever done something once.
/// </summary>
public class PulseConditionTests
{
    private static AlertEngineCore Core(params AlertRule[] rules) => AlertEngineFixture.Core(rules);

    private static AlertRule Rule(PulseMetric metric, ThresholdOp op, double value, string id = "r1") =>
        AlertEngineFixture.Rule(new PulseCondition(metric, op, value, 200), id: id);

    // A pump cycling every two seconds slows to one every eight. Nothing about the readings' own
    // values changed — the same rest, the same peak, the same duty — and no threshold rule in the
    // engine would notice.
    [Fact]
    public void A_pulse_train_that_slows_fires_a_period_rule()
    {
        var core = Core(Rule(PulseMetric.Period, ThresholdOp.Gt, 4000));
        var every200ms = TimeSpan.FromMilliseconds(200);

        var fast = Streams.Feed(core, Streams.Train(400, period: 10), AlertEngineFixture.T0, every200ms);
        var slow = Streams.Feed(core, Streams.Train(400, period: 40), fast.At, every200ms);

        Assert.Empty(fast.Raised);
        Assert.Single(slow.Raised);
    }

    // One excursion has no period: there is no second start to measure to. The condition is
    // Skipped and the skip is counted, which is what tells the panel the difference between a
    // rule that judged and said no and a rule that has nothing to judge yet.
    [Fact]
    public void A_period_that_does_not_exist_yet_is_skipped_and_counted_rather_than_false()
    {
        var core = Core(Rule(PulseMetric.Period, ThresholdOp.Gt, 0));

        // Sixty readings, one excursion in them.
        var fed = Streams.Feed(core, Enumerable.Range(0, 60).Select(i => i is 30 or 31 ? 5d : 0d),
                               AlertEngineFixture.T0, TimeSpan.FromMilliseconds(200));

        var diagnostic = Assert.Single(core.Snapshot().Rules);

        Assert.Empty(fed.Raised);
        Assert.Equal(60L, diagnostic.Skipped);
        Assert.Equal(0L, diagnostic.Evaluated);
    }

    // Twenty readings of a hundred are events, and those twenty are five seconds apart while the
    // eighty are a tenth of a second apart — so the events own about nineteen twentieths of the
    // elapsed time and a fifth of the run. Duty is the fifth.
    [Fact]
    public void Duty_is_the_share_of_the_readings_and_not_the_share_of_the_time()
    {
        var core = Core(Rule(PulseMetric.Duty, ThresholdOp.Gt, 0.3, id: "time"),
                        Rule(PulseMetric.Duty, ThresholdOp.Gt, 0.15, id: "readings"));

        var readings = Enumerable.Range(0, 100).Select(i => i % 5 == 0
            ? (5d, TimeSpan.FromSeconds(5))
            : (0d, TimeSpan.FromMilliseconds(100)));

        var fed = Streams.Feed(core, readings, AlertEngineFixture.T0);

        Assert.Equal("readings", Assert.Single(fed.Raised).RuleId);
    }
}
