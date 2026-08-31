using System.Globalization;
using MqttForge.Application.Alerts;
using MqttForge.Application.Alerts.Conditions;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;

namespace MqttForge.UnitTests.Application.Alerts;

/// <summary>
/// The condition that asks whether a reading belongs with the ones before it.
///
/// Two kinds of test live here and they are worth telling apart. The arithmetic ones drive
/// <see cref="Outlier.Judge"/> against a window built by hand, because a fence is a number and a
/// number should be pinned where it can be read off the assertion. The scenario ones drive the
/// whole engine with the spec's own runs — a boiler that steps, a current loop that saturates, a
/// clean line with one spike in it — because what this condition is for is not the fence but what
/// the alarm does over the next fifty readings.
/// </summary>
public class OutlierConditionTests
{
    private static readonly DateTimeOffset T0 = new(2026, 8, 30, 9, 0, 0, TimeSpan.Zero);

    private const string Topic = "plant/boiler/temp";

    private static AlertRule Rule(
        OutlierMethod method = OutlierMethod.Tukey,
        double k = 0,
        int window = 0,
        string id = "r1") =>
        new(id, "Boiler temperature", Enabled: true, Topic, Field: null,
            new OutlierCondition(method, k, window), Clear: null, For: null, Cooldown: 0,
            AlertSeverity.Critical, [new ScreenAction()]);

    private static AlertEngineCore Engine(params AlertRule[] rules)
    {
        var engine = new AlertEngineCore(new AlertEngineOptions());
        engine.SetRules(rules, T0);
        return engine;
    }

    private static MqttMessage Msg(double value, DateTimeOffset at) =>
        new(Topic, value.ToString(CultureInfo.InvariantCulture), "text", Qos: 0, Retain: false,
            ReceivedAt: at);

    /// <summary>
    /// A line resting at <paramref name="level"/>, a tenth either side of it, one reading every
    /// hundred milliseconds. Returns the instant the next reading is due at.
    /// </summary>
    // Alternating rather than random: the fences below are quoted to the digit in the comments,
    // and a run whose quartiles depend on a seed could not be quoted at all.
    private static DateTimeOffset Steady(AlertEngineCore engine, double level, int readings,
                                         DateTimeOffset from)
    {
        var at = from;
        for (var i = 0; i < readings; i++)
        {
            engine.OnMessage(Msg(level + (i % 2 == 0 ? -0.1 : 0.1), at), at);
            at = at.AddMilliseconds(100);
        }

        return at;
    }

    /// <summary>
    /// A window holding 0, 1, 2 … <paramref name="count"/> - 1, oldest first.
    ///
    /// Every number in the boundary theory comes off this run: sorted, q1 is 4.75 and q3 is
    /// 14.25, so the interquartile range is 9.5; the median and the mean are both 9.5, and the
    /// population deviation is √33.25 = 5.766281…
    /// </summary>
    private static TopicWindow Ramp(int count, int capacity = 20)
    {
        var window = new TopicWindow(capacity);
        for (var i = 0; i < count; i++)
            window.Add(new Reading(T0.AddMilliseconds(i).UtcTicks, i));

        return window;
    }

    private static TopicWindow Pinned(double value, int count = 20)
    {
        var window = new TopicWindow(count);
        for (var i = 0; i < count; i++)
            window.Add(new Reading(T0.AddMilliseconds(i).UtcTicks, value));

        return window;
    }

    // ── The fence ────────────────────────────────────────────────────────────────────────────

    // Tukey's fences are q1 - k·iqr and q3 + k·iqr, and sigma's are mean ± k·sd. Both are strict:
    // a reading exactly on the fence is inside it, which is the same choice BandCondition makes
    // at 20.0 on a 4-20 mA loop and for the same reason — the boundary is a value real sensors
    // produce, and an alarm that fires on it fires on the healthy case.
    [Theory]
    // k absent is k 1.5: q3 + 1.5 · 9.5 = 28.5, exactly.
    [InlineData(OutlierMethod.Tukey, 0, 28.5, false)]
    [InlineData(OutlierMethod.Tukey, 0, 28.6, true)]
    [InlineData(OutlierMethod.Tukey, 1.5, 28.5, false)]
    [InlineData(OutlierMethod.Tukey, 1.5, 28.6, true)]
    // The low fence, 4.75 - 1.5 · 9.5 = -9.5. A dip is an outlier as much as a spike is.
    [InlineData(OutlierMethod.Tukey, 1.5, -9.5, false)]
    [InlineData(OutlierMethod.Tukey, 1.5, -9.6, true)]
    // The two ends of the range the validator allows: 14.25 + 0.5 · 9.5 = 19, and + 5 · 9.5 = 61.75.
    [InlineData(OutlierMethod.Tukey, 0.5, 19.0, false)]
    [InlineData(OutlierMethod.Tukey, 0.5, 19.1, true)]
    [InlineData(OutlierMethod.Tukey, 5, 61.7, false)]
    [InlineData(OutlierMethod.Tukey, 5, 61.8, true)]
    // k absent is k 3 for sigma: 9.5 + 3 · 5.766281 = 26.798844…
    [InlineData(OutlierMethod.Sigma, 0, 26.7, false)]
    [InlineData(OutlierMethod.Sigma, 0, 26.9, true)]
    [InlineData(OutlierMethod.Sigma, 3, 26.7, false)]
    [InlineData(OutlierMethod.Sigma, 3, 26.9, true)]
    // Sigma's own two ends: 9.5 + 5.766281 = 15.266…, and 9.5 + 57.66281 = 67.162…
    [InlineData(OutlierMethod.Sigma, 1, 15.2, false)]
    [InlineData(OutlierMethod.Sigma, 1, 15.3, true)]
    [InlineData(OutlierMethod.Sigma, 10, 67.1, false)]
    [InlineData(OutlierMethod.Sigma, 10, 67.2, true)]
    public void The_fence_is_where_the_multiplier_puts_it(
        OutlierMethod method, double k, double value, bool outlying)
    {
        var verdict = Outlier.Judge(new OutlierCondition(method, k, Window: 0), Ramp(20), value);

        Assert.Equal(outlying ? Verdict.True : Verdict.False, verdict);
    }

    // The 4-20 mA loop the spec names, at the helper level: two hundred readings of exactly 20.0
    // have no box and no deviation, so `Summary` — which mirrors stats.ts — reports no outliers
    // at all. The condition has to answer anyway, and the answer it gives is the only one that
    // could be right about a saturated sensor.
    [Theory]
    [InlineData(OutlierMethod.Tukey, 20.0, false)]
    [InlineData(OutlierMethod.Tukey, 20.0001, true)]
    [InlineData(OutlierMethod.Tukey, 400.0, true)]
    [InlineData(OutlierMethod.Sigma, 20.0, false)]
    [InlineData(OutlierMethod.Sigma, 20.0001, true)]
    [InlineData(OutlierMethod.Sigma, 400.0, true)]
    public void A_run_that_never_moved_calls_everything_but_its_own_level_an_outlier(
        OutlierMethod method, double value, bool outlying)
    {
        var verdict = Outlier.Judge(new OutlierCondition(method, K: 0, Window: 0), Pinned(20.0), value);

        Assert.Equal(outlying ? Verdict.True : Verdict.False, verdict);
    }

    [Fact]
    public void Nineteen_readings_are_not_enough_to_judge_and_twenty_are()
    {
        var condition = new OutlierCondition(OutlierMethod.Tukey, K: 0, Window: 0);

        Assert.Equal(Verdict.Skipped, Outlier.Judge(condition, Ramp(19), 400.0));
        Assert.Equal(Verdict.True, Outlier.Judge(condition, Ramp(20), 400.0));
    }

    [Fact]
    public void A_missing_reading_is_skipped_and_never_false()
    {
        var condition = new OutlierCondition(OutlierMethod.Tukey, K: 0, Window: 0);

        Assert.Equal(Verdict.Skipped, Outlier.Judge(condition, Ramp(20), number: null));
        Assert.Equal(Verdict.Skipped, Outlier.Judge(condition, window: null, 400.0));
    }

    // The condition's own window narrows the sample to the newest readings of a longer ring,
    // which is the whole reason CopyValuesTo truncates to the newest end rather than the oldest.
    [Fact]
    public void A_condition_asking_for_twenty_is_judged_on_the_newest_twenty_of_a_longer_ring()
    {
        var window = new TopicWindow(100);
        for (var i = 0; i < 80; i++) window.Add(new Reading(T0.AddMilliseconds(i).UtcTicks, i * 100));
        for (var i = 0; i < 20; i++) window.Add(new Reading(T0.AddMilliseconds(80 + i).UtcTicks, i));

        // Against the newest twenty — the ramp again — 28.6 is past the fence at 28.5.
        Assert.Equal(
            Verdict.True,
            Outlier.Judge(new OutlierCondition(OutlierMethod.Tukey, K: 0, Window: 20), window, 28.6));

        // Against the whole hundred, whose quartiles are thousands apart, it is an ordinary
        // reading. Same ring, same value, two windows: the window is doing the work.
        Assert.Equal(
            Verdict.False,
            Outlier.Judge(new OutlierCondition(OutlierMethod.Tukey, K: 0, Window: 0), window, 28.6));
    }

    // A hand-edited rule file never met the validator, so a window below the floor arrives here
    // sooner or later. Judged on the floor rather than never judged: a rule that silently never
    // fires is the failure this repository refuses everywhere else.
    [Fact]
    public void A_window_smaller_than_the_floor_is_judged_on_the_floor()
    {
        Assert.Equal(
            Verdict.True,
            Outlier.Judge(new OutlierCondition(OutlierMethod.Tukey, K: 0, Window: 5), Ramp(20), 28.6));
    }

    // ── The engine ───────────────────────────────────────────────────────────────────────────

    // The spec's boiler: seventy degrees for two hundred readings, then ninety-five and it stays
    // there. This is the scenario the whole condition exists for, and the three things asserted
    // are the three things an operator would complain about if any of them were wrong — that it
    // rings, that it does not quietly stop ringing while the boiler is still at 95, and that it
    // does eventually stop rather than shouting until someone deletes the rule.
    [Fact]
    public void The_boiler_that_steps_to_95_rings_holds_and_then_accepts_the_new_level()
    {
        var engine = Engine(Rule());
        var at = Steady(engine, 70, 200, T0);

        var first = engine.OnMessage(Msg(95.0, at), at);
        Assert.Equal(Topic, Assert.Single(first.Raised).Topic);

        // Forty-eight more of the same. Nothing new rings — one alert per pair — and nothing
        // resolves, on an arrival or on a tick. Each of these readings is refused entry to the
        // ring, so the run behind them is still the seventy-degree one and 95 is still nothing
        // like it.
        var resolved = new List<Alert>();
        for (var i = 0; i < 48; i++)
        {
            at = at.AddMilliseconds(100);
            var outcome = engine.OnMessage(Msg(95.0, at), at);

            Assert.Empty(outcome.Raised);
            resolved.AddRange(outcome.Resolved);
            resolved.AddRange(engine.OnTick(at, connected: true).Resolved);
        }

        Assert.Empty(resolved);
        Assert.Single(engine.Snapshot().Active);

        // The fiftieth. A quarter of a two-hundred ring has now been refused in a row, which is
        // no longer a burst — it is where the plant lives.
        at = at.AddMilliseconds(100);
        var accepted = engine.OnMessage(Msg(95.0, at), at);

        var ended = Assert.Single(accepted.Resolved);
        Assert.Equal("new level accepted", ended.ResolvedBy);
        Assert.Empty(accepted.Raised);
        Assert.Empty(engine.Snapshot().Active);

        // And it stays quiet. The ring was emptied, so the next thirty readings are the new run
        // being learnt rather than thirty more outliers against the old one.
        for (var i = 0; i < 30; i++)
        {
            at = at.AddMilliseconds(100);
            Assert.Empty(engine.OnMessage(Msg(95.0, at), at).Raised);
        }

        Assert.Empty(engine.Snapshot().Active);
    }

    // The 4-20 mA loop through the engine rather than the helper: two hundred readings of exactly
    // 20.0, which is a sensor at the top of its range and perfectly healthy, and then a 400 that
    // is the loop broken. Nothing in `Summary` alone would have said a word about either.
    [Theory]
    [InlineData(OutlierMethod.Tukey)]
    [InlineData(OutlierMethod.Sigma)]
    public void A_line_pinned_at_exactly_20_rings_on_a_400_and_not_on_another_20(OutlierMethod method)
    {
        var engine = Engine(Rule(method));

        var at = T0;
        for (var i = 0; i < 200; i++)
        {
            engine.OnMessage(Msg(20.0, at), at);
            at = at.AddMilliseconds(100);
        }

        Assert.Empty(engine.OnMessage(Msg(20.0, at), at).Raised);

        at = at.AddMilliseconds(100);
        Assert.Single(engine.OnMessage(Msg(400.0, at), at).Raised);
    }

    // One spike in a clean run, and the point of the test is the last assertion. Sixty readings
    // either side of twenty give a deviation of a tenth, so the sigma fence is 20 ± 0.3. Had the
    // spike of 200 been written to the ring, the deviation would have gone to about 22.9 and the
    // fence to roughly ±68 — and the thirty at the end, which is a plain fault on this line,
    // would have been swallowed by a fence the fault itself had drawn.
    [Fact]
    public void A_spike_rings_once_clears_and_never_widens_the_fence_it_was_judged_against()
    {
        var engine = Engine(Rule(OutlierMethod.Sigma));
        var at = Steady(engine, 20, 60, T0);

        Assert.Single(engine.OnMessage(Msg(200.0, at), at).Raised);

        at = at.AddMilliseconds(100);
        Assert.Empty(engine.OnMessage(Msg(20.0, at), at).Raised);

        at = at.AddMilliseconds(100);
        var cleared = Assert.Single(engine.OnTick(at, connected: true).Resolved);
        Assert.Equal("clear", cleared.ResolvedBy);

        at = at.AddMilliseconds(100);
        Assert.Single(engine.OnMessage(Msg(30.0, at), at).Raised);
    }

    [Fact]
    public void Nothing_rings_until_the_ring_holds_twenty_readings()
    {
        var engine = Engine(Rule());

        var at = T0;
        for (var i = 0; i < 19; i++)
        {
            engine.OnMessage(Msg(20.0 + (i % 2 == 0 ? -0.1 : 0.1), at), at);
            at = at.AddMilliseconds(100);
        }

        // Nineteen readings is not a run, and a fence drawn round it is a guess wearing the
        // clothes of a measure. The panel's word for this state is "warming up".
        Assert.Empty(engine.OnMessage(Msg(400.0, at), at).Raised);
    }

    // The sentence the alert carries. It has to name the reading and the measure, because "the
    // condition held" tells the person reading the console nothing they did not already know
    // from the rule's name.
    [Fact]
    public void The_alert_names_the_reading_and_the_measure_that_refused_it()
    {
        var engine = Engine(Rule());
        var at = Steady(engine, 70, 200, T0);

        var alert = Assert.Single(engine.OnMessage(Msg(95.0, at), at).Raised);

        Assert.Equal("95 is an outlier (tukey, k 1.5)", alert.Reason);
        Assert.Equal(95.0, alert.Value);
    }

    [Fact]
    public void The_sigma_alert_says_sigma_and_the_k_it_actually_used()
    {
        var engine = Engine(Rule(OutlierMethod.Sigma, k: 4));
        var at = Steady(engine, 70, 200, T0);

        var alert = Assert.Single(engine.OnMessage(Msg(95.0, at), at).Raised);

        Assert.Equal("95 is an outlier (sigma, k 4)", alert.Reason);
    }
}
