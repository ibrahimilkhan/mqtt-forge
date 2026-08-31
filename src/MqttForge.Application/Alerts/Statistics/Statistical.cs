using System.Buffers;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;

namespace MqttForge.Application.Alerts.Statistics;

/// <summary>
/// The memory behind the statistical conditions: what a pair's readings have been settling into,
/// how often the question is worth asking again, and whether there is enough of a run to ask it.
///
/// The arithmetic is all in Statistics, Distribution and Shapes, which are faithful mirrors of the
/// browser's own and hold nothing. What is here is the part that only makes sense over time — the
/// part that turns a verdict about one window into a claim about a topic — and it is deliberately
/// one class, because distributionShift and shapeChange are the same machine with two nouns in it
/// and two copies of it would drift the moment either was tuned.
/// </summary>
// The bare name Statistics below is the class from task 1 and not the namespace this file sits in:
// lookup starts in the enclosing namespace, which declares that class, and only walks outward if
// it finds nothing. Files in MqttForge.Application.Alerts.Conditions do not have that luxury and
// alias it, which is why the alias is there and not here.
public static class Statistical
{
    /// <summary>
    /// The shortest run this engine will judge anything statistical on.
    /// </summary>
    // The same twenty as AlertEngineOptions.MinWindow, and a test in the warm-up task pins that
    // the two agree. The smallest window a rule is allowed to ask for is twenty readings, so a
    // pair holding fewer than twenty has not filled even the smallest window anybody could have
    // asked it to be judged on — whatever its own window is. Gating on this rather than on
    // Distribution.MinSample, which is twelve, means every statistical rule in the system warms up
    // to the same number and clears the distribution's own floor on the way past it.
    public const int EnoughToJudge = 20;

    /// <summary>How often a pair may be looked at statistically. The spec's own ceiling.</summary>
    // Sorting, fitting and shaping two thousand readings is not something to do fifty times a
    // second on twenty thousand pairs, and nothing is lost: a window a quarter of which is new is
    // the smallest change the machine below reacts to, and a topic cannot replace a quarter of its
    // window in less than a second unless it is sending faster than the quota anyway.
    //
    // Not AlertEngineOptions.DefaultCooldownSeconds, which is also a second and is a different
    // second: that one is how long an alarm stays quiet after it has cleared, and the two would
    // drift apart the first time either was tuned. Not an option on that record either — every
    // number there is a ceiling on what the engine holds, and this is the rate at which a question
    // can produce a new answer, which comes from the shape of the question rather than from the
    // size of the machine.
    public static readonly TimeSpan Quota = TimeSpan.FromSeconds(1);

    /// <summary>Cycles running before a name is believed.</summary>
    // Two, because one is a coincidence. A five per cent test refuses one healthy window in twenty
    // and consecutive windows overlap by three quarters, so a single cycle's verdict is neither
    // rare enough nor independent enough to ring a bell on.
    public const int BelievedAfter = 2;

    /// <summary>A whole window, in cycles. A cycle is a quarter of one, so this is four.</summary>
    private const int WindowInCycles = 4;

    /// <summary>
    /// Cycles running before a believed name becomes the baseline — and so before the alert it
    /// raised is allowed to go.
    /// </summary>
    // The spec: the edge clears when the new value has held a full window. Confirmation happens at
    // BelievedAfter, and a whole window after that is four more cycles, so the alert lives for
    // exactly one window of the new behaviour and then ends by itself.
    public const int SettledAfter = BelievedAfter + WindowInCycles;

    /// <summary>How many readings this pair is holding.</summary>
    public static int Have(TopicWindow? window) => window?.Count ?? 0;

    /// <summary>Whether this pair is still filling its minimum, and so claims nothing yet.</summary>
    public static bool Warming(TopicWindow? window) => Have(window) < EnoughToJudge;

    /// <summary>Whether anything in this tree judges statistically.</summary>
    // Walks the composites, because a statistical condition inside an 'any' is still one — and the
    // panel's warm-up line is about the pair, which does not know which arm of the tree wanted it.
    public static bool Judges(AlertCondition? condition) => condition switch
    {
        OutlierCondition or DistributionShiftCondition or ShapeChangeCondition or PulseCondition => true,
        AllCondition all => all.Of.Any(Judges),
        AnyCondition any => any.Of.Any(Judges),
        _ => false
    };

    /// <summary>Whether this pair may be looked at now.</summary>
    // The last clause is the one worth explaining. Two statistical conditions can sit in one rule's
    // tree, and they are evaluated one after the other against the same context — so they share an
    // instant. Without it, the first would take the second's turn away for the whole second, every
    // second, and a rule written as 'the distribution changed OR the pump has stopped' would only
    // ever answer its first arm. Two messages that genuinely arrived at the same instant get one
    // extra pass out of this, which is cheaper than a member on every pair to prevent it.
    public static bool MayLook(RuleState state, DateTimeOffset now)
        => state.LastStatistical is not { } last || now - last >= Quota || last == now;

    /// <summary>Spends this pair's turn.</summary>
    public static void Look(RuleState state, DateTimeOffset now) => state.LastStatistical = now;

    /// <summary>
    /// Moves the pair's memory on, if a cycle is due.
    ///
    /// Both families move together, off one clock, because they are two readings of one window and
    /// there is no version of 'the distribution is a cycle behind the shape' that anybody could
    /// explain. The clock is the ring's own: a quarter of a window of NEW readings, so a slow topic
    /// is judged on the same amount of new information as a fast one rather than on the same
    /// number of seconds.
    /// </summary>
    // The quota and the cycle are two gates in series and the pair is judged on the slower of them.
    // A rule asking for a quarter-window every fifty readings on a fifty-a-second topic therefore
    // gets a cycle a second at best, which is exactly the ceiling the quota is there to put on it.
    //
    // The turn is spent before the cycle is found to be due, and that is deliberate: a fit that
    // throws on a hostile window has still cost its second, rather than being retried fifty times
    // a second by a pair that never got as far as recording that it had tried.
    public static void Cycle(RuleState state, TopicWindow window, DateTimeOffset now)
    {
        if (!MayLook(state, now)) return;
        Look(state, now);

        var due = Math.Max(1, window.Capacity / 4);
        if (window.Added - state.ReadingsSinceCycle < due) return;
        state.ReadingsSinceCycle = window.Added;

        var count = window.Count;
        var readings = ArrayPool<Reading>.Shared.Rent(count);
        var values = ArrayPool<double>.Shared.Rent(count);

        try
        {
            var n = window.CopyTo(readings.AsSpan(0, count));
            for (var i = 0; i < n; i++) values[i] = readings[i].Value;

            // Null only for an empty ring, which the warm-up gate has already refused. Handled
            // rather than asserted: the type says it can happen, and a cycle that claims nothing is
            // the right answer to a window that holds nothing.
            var summary = Statistics.Summarise(values.AsSpan(0, n));
            if (summary is null) return;

            var fit = Distribution.Of(values.AsSpan(0, n));
            var shape = Shapes.Of(readings.AsSpan(0, n), summary);

            (state.ConfirmedFit, state.CandidateFit, state.FitCycles) =
                Advance(state.ConfirmedFit, state.CandidateFit, state.FitCycles, fit?.Name);

            // Unknown is the engine's own answer for a run it will not classify, and it is fed in
            // as 'no name' rather than as a name. A shape nobody could read is not a shape the
            // signal changed into.
            (state.ConfirmedShape, state.CandidateShape, state.ShapeCycles) =
                Advance(state.ConfirmedShape, state.CandidateShape, state.ShapeCycles,
                        shape.Id == ShapeId.Unknown ? null : shape.Id);
        }
        finally
        {
            ArrayPool<Reading>.Shared.Return(readings);
            ArrayPool<double>.Shared.Return(values);
        }
    }

    /// <summary>
    /// One family's memory, one cycle on.
    ///
    /// A cycle that saw nothing it could name changes nothing at all: the baseline is kept, the
    /// challenger's run is not broken, and nothing is recorded. That is the single most important
    /// line in this file. A window that fits nothing is a window with nothing to say, and an engine
    /// that let it become the baseline would ring on the way back to normal — which is the moment
    /// everything is fine again, and the worst possible moment to wake somebody.
    /// </summary>
    // Generic over the two enums rather than written twice: the machine is identical and the only
    // difference is which noun is in the sentence the panel prints.
    private static (T? Confirmed, T? Candidate, int Cycles) Advance<T>(
        T? confirmed, T? candidate, int cycles, T? seen) where T : struct
    {
        if (seen is null) return (confirmed, candidate, cycles);

        // Capped rather than left to climb. Past 'settled' the number decides nothing, and a
        // counter that runs for the life of the process is a counter that can overflow in it.
        if (Nullable.Equals(candidate, seen)) cycles = Math.Min(cycles + 1, SettledAfter);
        else (candidate, cycles) = (seen, 1);

        // The first name a pair ever settles on is a baseline, not a change. Nothing fires for it,
        // because there is nothing it changed from — a rule saved this morning would otherwise
        // alarm on every topic it matched as soon as each of them had said something twice.
        if (confirmed is null)
            return cycles >= BelievedAfter ? (seen, candidate, cycles) : (confirmed, candidate, cycles);

        // The challenger has held a whole window: it is what this pair is now, and the alert its
        // arrival raised has nothing left to say.
        return cycles >= SettledAfter ? (seen, candidate, cycles) : (confirmed, candidate, cycles);
    }

    /// <summary>Whether a believed distribution is standing against the one on record.</summary>
    public static bool FitChanged(RuleState state)
        => state.ConfirmedFit is { } confirmed
           && state.CandidateFit is { } candidate
           && state.FitCycles >= BelievedAfter
           && candidate != confirmed;

    /// <summary>Whether a believed shape is standing against the one on record.</summary>
    public static bool ShapeChanged(RuleState state)
        => state.ConfirmedShape is { } confirmed
           && state.CandidateShape is { } candidate
           && state.ShapeCycles >= BelievedAfter
           && candidate != confirmed;

    /// <summary>
    /// What the whole ring adds up to as a rhythm, or null when there is nothing in it.
    /// </summary>
    // Unconditional, and that is the decision the pulse condition rests on: the metrics are taken
    // whatever the shape turned out to be. A pump that has stopped pulsing is precisely the case
    // where the shape is no longer 'pulse', and a rule that asked the shape first would go silent
    // at the moment it was wanted.
    public static Pulses? PulsesFor(TopicWindow window)
    {
        var count = window.Count;
        if (count == 0) return null;

        var readings = ArrayPool<Reading>.Shared.Rent(count);
        var values = ArrayPool<double>.Shared.Rent(count);

        try
        {
            var n = window.CopyTo(readings.AsSpan(0, count));
            for (var i = 0; i < n; i++) values[i] = readings[i].Value;

            var summary = Statistics.Summarise(values.AsSpan(0, n));

            return summary is null ? null : Shapes.PulsesOf(readings.AsSpan(0, n), summary);
        }
        finally
        {
            ArrayPool<Reading>.Shared.Return(readings);
            ArrayPool<double>.Shared.Return(values);
        }
    }

    /// <summary>
    /// One metric off a rhythm, or null when that metric does not exist yet.
    /// </summary>
    // Null for a period with one excursion behind it and for a width with none finished, and those
    // nulls have to travel: 'no period' is not 'a short period', and a condition that read one as
    // the other would fire on every sensor that has done something exactly once.
    public static double? MetricOf(Pulses pulses, PulseMetric metric) => metric switch
    {
        PulseMetric.Count => pulses.Count,
        PulseMetric.Duty => pulses.Duty,
        PulseMetric.Period => pulses.Every,
        PulseMetric.Width => pulses.Width,

        // Not a silent default, for the reason the evaluator's own is not: a metric this build
        // cannot read has to reach the per-pair catch and mark the rule Faulted, or it is a rule
        // that looks fine and never fires. The validator refuses it first, so this is a fault in
        // our own code rather than anything a user can type.
        _ => throw new NotSupportedException($"No pulse metric for {metric}.")
    };
}
