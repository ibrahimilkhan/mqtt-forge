using System.Buffers;
using MqttForge.Application.Alerts.Statistics;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;

// The class that holds Summarise and the namespace it lives in are both called Statistics, and
// this file's own namespace sits under MqttForge.Application.Alerts — so a bare `Statistics.` here
// binds to the child namespace and does not compile. The alias is the shortest honest way round
// it, and it is repeated in every file in this plan that summarises anything.
using Stats = MqttForge.Application.Alerts.Statistics.Statistics;

namespace MqttForge.Application.Alerts.Conditions;

/// <summary>
/// Whether one reading belongs with the run that precedes it.
/// </summary>
// Static and pure, like the evaluator that calls it, and for a second reason as well: the engine
// calls it too. The evaluator asks so that a rule can fire; the engine asks so that it knows
// whether to let the reading into the ring, and the two answers must be the same answer or the
// alarm would be about a run the ring does not contain.
//
// Asking twice per arrival is a decision and not an oversight. The alternative is to compute the
// verdict once and carry it — which means a cache keyed by condition instance, allocated per
// arrival, to save a sort of at most two thousand doubles that costs tens of microseconds. One
// pure function asked twice is cheaper to run than that and very much cheaper to read.
public static class Outlier
{
    /// <summary>
    /// The fewest readings a fence may be drawn from.
    /// </summary>
    // The same twenty as AlertEngineOptions.MinWindow, deliberately: that is the smallest window a
    // rule is allowed to ask for, so a fence drawn from fewer readings than that is a fence nobody
    // is allowed to configure. Below it the condition is Skipped and never False — a run this
    // young has no opinion, and 'no opinion' must not read as 'this reading is fine'. It is also
    // comfortably above Distribution.MinSample of 12, which answers a different question: twelve
    // readings are enough to refuse a distribution, and not enough to accuse a reading.
    public const int EnoughToJudge = 20;

    /// <summary>The interquartile multiplier a tukey condition uses when none was given.</summary>
    // Tukey's own number, and the one stats.ts draws its fences with. A console whose chart marks
    // a reading as an outlier and whose alarm does not would be two tools disagreeing in front of
    // the same person.
    public const double TukeyK = 1.5;

    /// <summary>The deviations a sigma condition uses when none was given.</summary>
    public const double SigmaK = 3;

    public static double KOf(OutlierCondition condition) =>
        condition.K > 0
            ? condition.K
            : condition.Method is OutlierMethod.Sigma ? SigmaK : TukeyK;

    /// <summary>
    /// How many of the ring's newest readings this condition is judged on.
    /// </summary>
    // Two clamps, and each is a refusal to fail quietly. Never more than the ring holds, because
    // a rule asking for two thousand readings out of a two-hundred ring is asking for readings
    // that were never kept. Never fewer than the floor, because a hand-edited file carrying
    // window 5 would otherwise produce a rule that can never be judged at all — and a rule that
    // never fires and never says why is the one failure this engine's diagnostics exist to
    // prevent. A ring smaller than the floor is left alone: Judge below skips it, which is the
    // right answer while such a pair is warming up.
    public static int SampleOf(OutlierCondition condition, int capacity) =>
        Math.Min(capacity, Math.Max(condition.Window <= 0 ? capacity : condition.Window, EnoughToJudge));

    /// <summary>
    /// Whether <paramref name="number"/> belongs with the readings already in
    /// <paramref name="window"/>. The window must not yet contain it.
    /// </summary>
    public static Verdict Judge(OutlierCondition condition, TopicWindow? window, double? number)
    {
        // No ring, no reading, or a reading that is not a number: nothing was judged. Skipped and
        // never False, which is the spec's 'eksik veri değerlendirilmez, yanlış sayılmaz'.
        if (window is null || number is not { } value || !double.IsFinite(value)) return Verdict.Skipped;

        var wanted = Math.Min(window.Count, SampleOf(condition, window.Capacity));
        if (wanted < EnoughToJudge) return Verdict.Skipped;

        // Rented rather than allocated. This runs on every arrival of every pair whose rule asks
        // for an outlier — the one statistical condition the once-a-second quota does not hold
        // back — and a two-thousand-reading window is sixteen kilobytes a message otherwise.
        var buffer = ArrayPool<double>.Shared.Rent(wanted);
        try
        {
            var held = window.CopyValuesTo(buffer.AsSpan(0, wanted));

            // Null only for an empty sample, which the floor above has already excluded; handled
            // rather than asserted because the two files are meant to be readable apart.
            return Stats.Summarise(buffer.AsSpan(0, held)) is not { } summary
                ? Verdict.Skipped
                : Outlying(condition, summary, value) ? Verdict.True : Verdict.False;
        }
        finally
        {
            ArrayPool<double>.Shared.Return(buffer);
        }
    }

    /// <summary>
    /// Whether any of a rule's outlier conditions refuses this reading a place in the ring.
    /// </summary>
    // Any, not all: a reading one condition on the rule has just called an outlier must not
    // become evidence for the fence another condition on the same rule draws next time.
    public static bool Rejects(IReadOnlyList<OutlierCondition> conditions, TopicWindow window, double value)
    {
        for (var i = 0; i < conditions.Count; i++)
            if (Judge(conditions[i], window, value) is Verdict.True)
                return true;

        return false;
    }

    /// <summary>
    /// The fence itself, and the two degenerate runs that have no fence at all.
    /// </summary>
    // Summary.Fences is deliberately not read here. It is stats.ts's fence — 1.5 times the
    // interquartile range, always — and this condition's multiplier is the rule's. The quartiles
    // are what the two share, and they are what is read.
    //
    // The degenerate answers are this method's own, and they are the reason rule 5 of the contract
    // exists. `Summary` mirrors stats.ts, which reports no outliers when the box has no width,
    // because a chart cannot draw a fence round nothing. An alarm can: a line that has read
    // exactly 20.0 two hundred times and then reads 400 has said the most reportable thing a
    // 4-20 mA loop ever says, and a condition that answered False there would be silent on
    // precisely the sensor the spec names.
    private static bool Outlying(OutlierCondition condition, Summary summary, double value)
    {
        var k = KOf(condition);

        if (condition.Method is OutlierMethod.Sigma)
            return summary.Sd > 0
                ? Math.Abs(value - summary.Mean) > k * summary.Sd
                : value != summary.Mean;

        var iqr = summary.Q3 - summary.Q1;

        // Strictly past the fence, on both sides. A reading exactly on it is inside it — the same
        // choice BandCondition makes at 20.0 on a 4-20 mA loop, and for the same reason: the
        // boundary is a value real sensors produce, often.
        return iqr > 0
            ? value < summary.Q1 - k * iqr || value > summary.Q3 + k * iqr
            : value != summary.Median;
    }
}
