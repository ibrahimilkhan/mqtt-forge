using System.Buffers;
using MqttForge.Domain.Models;

namespace MqttForge.Application.Alerts.Statistics;

/// <summary>
/// What kind of thing a run of readings is, which decides what can honestly be said about it.
/// </summary>
// A mean is a fact about a temperature and a fiction about a door sensor: 'the door was 0.3 open
// on average' describes nothing that ever happened. The same goes for a pulse train, where the
// average sits in the gap between the two levels the signal actually visits. So the run is
// classified first, and everything downstream follows the classification.
//
// Unknown is the one member web/src/lib/shape.ts does not have, and it is the reason this is an
// enum rather than a straight transliteration. The original answers 'continuous' below
// EnoughToClassify because a chart has to draw something; the engine's caller is not a chart.
// shapeChange compares one confirmed classification with the next, so a run that has not earned
// a classification must be recorded as nothing at all — otherwise every new pair fires a
// shape-change alert on its ninth reading, as the placeholder 'continuous' gives way to the
// first real answer. Unknown is the value that makes 'not yet' expressible, and rule 7 leans on
// it: a null or unknown keeps the confirmed value, is never recorded as a baseline, never fires.
public enum ShapeId
{
    /// Fewer readings than EnoughToClassify. Not a verdict — the absence of one.
    Unknown,

    /// Readings of a quantity. Means, deviations and trends all mean what they usually mean.
    Continuous,

    /// A handful of levels the run moves between. Counted and timed, not averaged.
    State,

    /// A rest with events on it. Same treatment, different arithmetic to find the rest.
    Pulse,
}

/// <summary>What a run of events adds up to, when averaging it would describe nothing.</summary>
public sealed record Pulses(
    /// <summary>The level the run sits at between events.</summary>
    double Rest,
    /// <summary>The level it goes to.</summary>
    double Peak,
    /// <summary>The line between the two, which every count below is taken against.</summary>
    double Threshold,
    /// <summary>Separate excursions past it.</summary>
    int Count,
    /// <summary>The share of READINGS spent past it, from 0 to 1. Never a share of time.</summary>
    double Duty,
    /// <summary>Middle time from one excursion's start to the next, in milliseconds. Null with
    /// fewer than two excursions.</summary>
    double? Every,
    /// <summary>Middle time an excursion lasts, in milliseconds. Null when none has finished.</summary>
    double? Width);

/// <summary>A run's classification, and the event metrics that go with it.</summary>
// Levels is 0 for Continuous and Unknown. The original's `{ id: 'continuous' }` carries no levels
// field at all; a non-nullable int has to hold something, and a count of levels nobody counted is
// the only honest thing to put there.
public sealed record Shape(ShapeId Id, int Levels, Pulses? Pulses);

/// <summary>
/// The mirror of web/src/lib/shape.ts, constant for constant.
/// </summary>
// The console and the engine must reach the same verdict about the same run, or a reader looking
// at a chart that says 'pulse' while an alert says 'state' has two tools and no answer. So the
// arithmetic here is the arithmetic there, including two places where it is odd, both marked
// below: the un-interpolated median inside Reach and Middle, and spiking's override of the rest
// and peak that PulsesAt had just worked out.
public static class Shapes
{
    /// <summary>Below this a run has no habits, and every rule here reads a coincidence.</summary>
    public const int EnoughToClassify = 8;

    /// More levels than this and the readings are a quantity that happens to be coarse.
    private const int MostLevels = 4;

    /// Two levels is a switch, whatever the split between them.
    private const int ASwitch = 2;

    /// How much of its fair share a level has to hold to be a state rather than an event.
    ///
    /// Without this, a sensor reading 1, 2, 3 all day with three spikes in it has four levels and
    /// reads as a four-state machine — when what it really is is a small signal with events on
    /// top of it, and the events are the thing. Half of an even split is a generous floor: a run
    /// really moving between four states can be lopsided about it, but not a hundred to one.
    private const double HoldsItsShare = 0.5;

    /// A level the run visited once is somewhere it went, not somewhere it lives.
    private const int VisitsAgain = 2;

    /// Below this the run crossed between its levels once, which is a step rather than a switch.
    private const int LeavesAndReturns = 2;

    /// Past this share of the run, an excursion is not an event on a rest — it is the run.
    private const double MostOfADuty = 0.35;

    /// Fewer than this and it is one thing that happened, not a rhythm.
    private const int FewestPulses = 3;

    /// How far past the run's own scatter a reading has to be to count as leaving the rest.
    private const int DepartsBy = 6;

    private static readonly Shape Unclassified = new(ShapeId.Unknown, 0, null);

    private static readonly Shape Measurements = new(ShapeId.Continuous, 0, null);

    /// <summary>
    /// What the run is. The summary must be the summary of these same readings' values.
    /// </summary>
    public static Shape Of(ReadOnlySpan<Reading> readings, Summary summary)
    {
        // Split out of the original's single `length < ENOUGH || high === low` guard, because the
        // two arms now give different answers: too short is Unknown, never moved is Continuous.
        // A run that never moved is a quantity that is not moving, which is a classification; a
        // run of five readings is not one yet. The length is checked first, so a flat run of five
        // is Unknown rather than Continuous.
        if (readings.Length < EnoughToClassify) return Unclassified;
        if (summary.High == summary.Low) return Measurements;

        var (levels, least) = Tally(readings);

        // A handful of levels, each of them somewhere the run actually lives: a switch, a mode, a
        // state machine. Checked before the pulse test, since a switch also rests and leaves —
        // the difference is that its rest is one exact value rather than a band the readings
        // wander in. The threshold is halfway between the lowest and highest level, which is what
        // the original's midpoint() computes from the values; Summary already holds both ends.
        if (levels <= MostLevels && Lived(levels, least, readings.Length))
        {
            var pulses = PulsesAt(readings, (summary.Low + summary.High) / 2, summary);

            // A run that crossed between its levels once did not switch — it stepped, and a step
            // is better described by how far it moved and when. A switch goes back and forth.
            if (pulses.Count >= LeavesAndReturns) return new Shape(ShapeId.State, levels, pulses);
        }

        var events = Spiking(readings, summary);

        return events is null ? Measurements : new Shape(ShapeId.Pulse, levels, events);
    }

    /// <summary>
    /// The excursions in a run, whatever kind of run it is.
    /// </summary>
    // Unconditional on purpose, and that is the contract's rule 9. The pulse condition asks how
    // many excursions there have been, what the duty is, how long the period and the width are —
    // and those are answerable about a flow meter whether or not the flow meter has yet
    // accumulated the three excursions Of demands before it will call the run a pulse train. This
    // is Spiking with every gate removed: the same rest, the same reach, the same threshold, and
    // none of the away == 0 / MostOfADuty / FewestPulses tests, and none of the rest/peak
    // override either. What comes back is PulsesAt's own reading of the ends.
    public static Pulses PulsesOf(ReadOnlySpan<Reading> readings, Summary summary)
    {
        // Summary refuses an empty run by returning null, so nothing should reach here with one.
        // Refused loudly anyway: Duty would be a division by zero, and a NaN duty compared with a
        // threshold is silently false — a condition that answers 'no' for a reason nobody can see
        // is the worst failure this file could have.
        ArgumentOutOfRangeException.ThrowIfZero(readings.Length);

        return PulsesAt(readings, Departure(readings, summary).Threshold, summary);
    }

    /// <summary>
    /// A run that rests somewhere and occasionally leaves, or null when it does not.
    /// </summary>
    // The rest is the middle reading, and 'leaving' is measured against the run's own scatter
    // about it rather than against a fixed size — a pressure that idles at 1013 and spikes to
    // 1400 and a flow meter that idles at 0 and spikes to 3 are the same signal, and only the
    // second of them would clear any threshold written in units.
    //
    // Three excursions at least: one is an outlier, which the outlier condition already rings,
    // and two is a coincidence. A run that spends more than about a third of itself away from the
    // rest does not have a rest — it has two levels, and either the state test above caught it or
    // it is a quantity moving between them.
    private static Pulses? Spiking(ReadOnlySpan<Reading> readings, Summary summary)
    {
        var (threshold, away, peak) = Departure(readings, summary);

        if (away == 0 || away > readings.Length * MostOfADuty) return null;

        var pulses = PulsesAt(readings, threshold, summary);

        // The override, reproduced from the original and worth naming. PulsesAt has just named
        // the rest and the peak from the summary's ends by the minority rule; here they are
        // replaced by the median and by whichever end the excursions actually went to. Both
        // readings are right about different questions — the shape's rest is where the signal
        // lives, PulsesAt's is the lowest reading in the window — and the pulse-train vector in
        // tests/fixtures/statistics pins the two apart at 0.04 and 0.01.
        return pulses.Count >= FewestPulses
            ? pulses with { Rest = summary.Median, Peak = peak }
            : null;
    }

    /// <summary>Where the rest ends: the threshold, how many readings are past it, and which end.</summary>
    // One method so that Spiking and PulsesOf cannot drift apart. The peak is the end the
    // excursions actually go to; a run that dips instead of spiking is the same signal upside
    // down, and reading it against the wrong end would count every rest as one excursion. With no
    // excursions at all, above and away are both nought and the test holds, which puts the peak
    // at the high end — arbitrary, but it only reaches a caller that has already given up.
    private static (double Threshold, int Away, double Peak) Departure(
        ReadOnlySpan<Reading> readings,
        Summary summary)
    {
        var rest = summary.Median;
        var reach = Reach(readings, rest);

        var away = 0;
        var above = 0;

        foreach (var reading in readings)
        {
            var stray = reading.Value - rest;

            if (Math.Abs(stray) > reach) away++;
            if (stray > reach) above++;
        }

        var peak = above * 2 >= away ? summary.High : summary.Low;

        return (rest + (peak - rest) / 2, away, peak);
    }

    /// <summary>How far from the rest a reading has to be to have left it.</summary>
    // The median absolute deviation, six times over. Note that this median is NOT Summary.Median:
    // it is the entry at floor(length / 2) with no interpolation, which on an even count is the
    // upper of the two middles. That is what shape.ts does, and unifying the two definitions
    // would move the reach on every even-length window — which is every window the engine holds,
    // since the ring fills to a capacity the rule chose. Kept faithful deliberately.
    private static double Reach(ReadOnlySpan<Reading> readings, double rest)
    {
        var rented = ArrayPool<double>.Shared.Rent(readings.Length);

        try
        {
            var strays = rented.AsSpan(0, readings.Length);
            for (var index = 0; index < readings.Length; index++)
                strays[index] = Math.Abs(readings[index].Value - rest);

            strays.Sort();

            var scatter = strays[readings.Length / 2];

            // With no scatter at all, anything that is not the rest has left it.
            return scatter > 0 ? DepartsBy * scatter : 0;
        }
        finally
        {
            ArrayPool<double>.Shared.Return(rented);
        }
    }

    /// <summary>The excursions past a threshold, counted and timed.</summary>
    // 'Past' is whichever side the run spends less of itself on, so the same arithmetic reads a
    // sensor that idles low and pulses high and one that idles high and drops — a door that is
    // shut all day and open twice has two events, not four hundred. A dead heat reads high as the
    // event, which is the convention every logic analyser uses.
    private static Pulses PulsesAt(ReadOnlySpan<Reading> readings, double threshold, Summary summary)
    {
        var n = readings.Length;

        var high = 0;
        foreach (var reading in readings)
            if (reading.Value >= threshold) high++;

        var eventIsHigh = high * 2 <= n;

        // One rental for both lists. Neither can hold more than one entry per reading, and the
        // ring is capped at MaxWindow, so this is at most a 32 kB rental on the largest window
        // the engine allows — and it happens at most once a second per pair, because everything
        // that calls it is quota-bound by rule 3.
        var rented = ArrayPool<double>.Shared.Rent(n * 2);

        try
        {
            var gaps = rented.AsSpan(0, n);
            var widths = rented.AsSpan(n, n);
            var gapCount = 0;
            var widthCount = 0;

            var count = 0;
            var events = 0;
            var open = -1;
            long lastStart = 0;

            for (var index = 0; index < n; index++)
            {
                var value = readings[index].Value;
                var isEvent = eventIsHigh ? value >= threshold : value < threshold;

                if (isEvent)
                {
                    events++;

                    if (open < 0)
                    {
                        if (count > 0) gaps[gapCount++] = Milliseconds(readings[index].Ticks - lastStart);

                        lastStart = readings[index].Ticks;
                        open = index;
                        count++;
                    }

                    continue;
                }

                // Measured to the first reading that is back at rest: an excursion one reading
                // long lasted until the next reading said otherwise, not for no time at all.
                if (open >= 0) widths[widthCount++] = Milliseconds(readings[index].Ticks - readings[open].Ticks);

                open = -1;
            }

            return new Pulses(
                eventIsHigh ? summary.Low : summary.High,
                eventIsHigh ? summary.High : summary.Low,
                threshold,
                count,
                // The share of readings, never of time. A window is a run of arrivals and not a
                // stretch of clock: a device that reports every second for an hour and then every
                // ten seconds for an hour has not changed its duty by slowing down.
                events / (double)n,
                Middle(gaps[..gapCount]),
                Middle(widths[..widthCount]));
        }
        finally
        {
            ArrayPool<double>.Shared.Return(rented);
        }
    }

    /// <summary>The middle of a list, or null when there is nothing in it.</summary>
    // Null and not zero, and the distinction is load-bearing: rule 9 says a null period or width
    // means the metric does not exist yet, so the pulse condition is SKIPPED rather than false.
    // Zero would say the excursions lasted no time, which is an answer, and a wrong one.
    //
    // The same un-interpolated middle as Reach uses, for the same reason: it is what shape.ts
    // does. The span is sorted in place, which is why the callers hand it rented scratch space.
    private static double? Middle(Span<double> values)
    {
        if (values.Length == 0) return null;

        values.Sort();

        return values[values.Length / 2];
    }

    /// <summary>Ticks to milliseconds, keeping the fraction.</summary>
    // A division rather than a truncation. Reading.Ticks is UtcTicks, so it carries 100ns, and a
    // burst of pulses arriving inside one millisecond would otherwise report a width of zero —
    // which reads as 'no time at all' and is exactly the case the pulse condition exists to
    // measure. shape.ts cannot do this: a JavaScript Date holds whole milliseconds and nothing
    // finer. So this is the one place the mirror is sharper than the original rather than
    // different from it, and on the shared vectors — whose timestamps are whole milliseconds —
    // the two give identical answers.
    private static double Milliseconds(long ticks) => ticks / (double)TimeSpan.TicksPerMillisecond;

    /// <summary>How many distinct values the run holds, and how few readings the rarest has.</summary>
    // A dictionary sized by the run, which for a continuous window of two thousand is two
    // thousand entries. Kept rather than capped, because the pulse branch reports the level count
    // and a capped tally could not. It is affordable for the same reason the rental above is:
    // once a second per pair, at most.
    //
    // Keyed on double, where .NET's default comparer treats -0.0 and 0.0 as one key — which is
    // what a JavaScript Map does too, so a device reporting a signed zero counts the same on both
    // sides.
    private static (int Levels, int Least) Tally(ReadOnlySpan<Reading> readings)
    {
        var seen = new Dictionary<double, int>();

        foreach (var reading in readings)
        {
            seen.TryGetValue(reading.Value, out var held);
            seen[reading.Value] = held + 1;
        }

        var least = int.MaxValue;
        foreach (var held in seen.Values) least = Math.Min(least, held);

        return (seen.Count, least);
    }

    /// <summary>Whether every level is somewhere the run lives rather than somewhere it went once.</summary>
    // Two of them is a switch however lopsided the split, since there is nothing else two levels
    // could be. Past two, each has to be visited more than once and hold something like its share
    // — otherwise a quantity with one wild reading in it has an extra 'level' and reads as a
    // machine.
    //
    // The cost of that is the spec's own case: a two-state signal carrying a rare third value
    // fails on the first clause and stops being a state machine on that single reading. It is a
    // real quirk and it is reproduced rather than corrected, because the confirmation machine in
    // rule 7 is the answer to it — a candidate has to survive two consecutive cycles before it
    // becomes the confirmed shape, so one stray reading changes nothing anybody hears about.
    private static bool Lived(int levels, int least, int n)
    {
        if (least < VisitsAgain) return false;

        return levels <= ASwitch || least / (double)n >= HoldsItsShare / levels;
    }
}
