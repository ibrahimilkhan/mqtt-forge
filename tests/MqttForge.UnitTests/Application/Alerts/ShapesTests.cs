using MqttForge.Application.Alerts.Statistics;
using MqttForge.Domain.Models;
using Xunit;

namespace MqttForge.UnitTests.Application.Alerts;

/// <summary>
/// What kind of thing a run of readings is.
///
/// The whole file is one argument: a mean is a fact about a temperature and a fiction about a
/// door. 'The door was 0.3 open on average' describes nothing that ever happened, and an alert
/// written against that number is an alert about an event that has no instant. So a run is
/// classified before anything is said about it, and the numbers that follow are the ones the
/// classification allows — a count and a duty for a door, a mean and a slope for a boiler.
///
/// Every number asserted below came out of web/src/lib/shape.ts, which is the original this
/// mirrors. Where the two would disagree the test says so and says which is which.
/// </summary>
public class ShapesTests
{
    private static readonly DateTimeOffset Start = new(2026, 8, 30, 12, 0, 0, TimeSpan.Zero);

    /// <summary>One reading a second, the cadence every timing below is read against.</summary>
    private static Reading[] Run(params double[] values) => Every(TimeSpan.TicksPerSecond, values);

    /// <summary>The same readings on any spacing, in ticks.</summary>
    private static Reading[] Every(long ticks, params double[] values)
    {
        var readings = new Reading[values.Length];
        for (var index = 0; index < values.Length; index++)
            readings[index] = new Reading(Start.UtcTicks + index * ticks, values[index]);

        return readings;
    }

    /// <summary>The same readings on gaps given one by one, in milliseconds from the start.</summary>
    private static Reading[] At(long[] milliseconds, double[] values)
    {
        var readings = new Reading[values.Length];
        for (var index = 0; index < values.Length; index++)
            readings[index] = new Reading(
                Start.UtcTicks + milliseconds[index] * TimeSpan.TicksPerMillisecond,
                values[index]);

        return readings;
    }

    private static Summary SummaryOf(Reading[] readings)
    {
        var values = new double[readings.Length];
        for (var index = 0; index < readings.Length; index++) values[index] = readings[index].Value;

        return Statistics.Summarise(values) ?? throw new InvalidOperationException("no summary");
    }

    private static Shape ShapeOf(Reading[] readings) => Shapes.Of(readings, SummaryOf(readings));

    private static Pulses PulsesOf(Reading[] readings) => Shapes.PulsesOf(readings, SummaryOf(readings));

    /// <summary>A quantity that wanders: two turns of a sine about 21.5, a degree either side.</summary>
    private static Reading[] Sine() =>
        Run(21.5, 22.5, 23.23, 23.5, 23.23, 22.5, 21.5, 20.5, 19.77, 19.5, 19.77, 20.5,
            21.5, 22.5, 23.23, 23.5, 23.23, 22.5, 21.5, 20.5, 19.77, 19.5, 19.77, 20.5);

    /// <summary>A door: shut, open twice briefly and once for three readings.</summary>
    private static readonly double[] Door =
        [0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0];

    /// <summary>A link that is up all day and drops twice.</summary>
    private static Reading[] Link() =>
        Run(1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1);

    /// <summary>A flow meter idling on noise near zero, with three squirts of about five.</summary>
    private static Reading[] PulseTrain() =>
        Run(0.02, 0.05, 0.01, 0.04, 0.03, 0.06, 0.02, 5.1, 5.3, 0.03,
            0.01, 0.05, 0.02, 0.04, 0.06, 4.9, 5.2, 0.02, 0.03, 0.01,
            0.05, 0.04, 0.02, 5.4, 5, 0.03, 0.06, 0.01, 0.04, 0.02);

    [Fact]
    public void Reads_a_run_of_measurements_as_measurements()
    {
        var shape = ShapeOf(Sine());

        Assert.Equal(ShapeId.Continuous, shape.Id);
        Assert.Equal(0, shape.Levels);
        Assert.Null(shape.Pulses);
    }

    // Eight readings is the floor, and below it the answer is not 'continuous' — it is 'nothing
    // yet'. shape.ts says continuous here because a chart has to draw a line either way; the
    // engine has a caller that would take that for a classification and fire a shapeChange alert
    // the moment the ninth reading turned it into a state.
    [Fact]
    public void Says_nothing_about_a_run_too_short_to_have_a_shape()
    {
        var shape = ShapeOf(Run(0, 0, 1, 0, 0));

        Assert.Equal(ShapeId.Unknown, shape.Id);
        Assert.Equal(0, shape.Levels);
        Assert.Null(shape.Pulses);
    }

    // The pulse metrics have no such floor: the condition asks how many excursions there have
    // been, and 'one, so far' is a true answer to that on a five-reading run.
    [Fact]
    public void Still_answers_the_pulse_metrics_of_a_run_too_short_to_classify()
    {
        var pulses = PulsesOf(Run(0, 0, 1, 0, 0));

        Assert.Equal(1, pulses.Count);
        Assert.Equal(0.2, pulses.Duty, 9);
        Assert.Null(pulses.Every);
        Assert.Equal(1000, pulses.Width!.Value, 9);
    }

    // A run that never moved is a quantity that is not moving, which is a classification and not
    // a shrug — so Continuous, not Unknown. The length floor is checked first, so a flat run of
    // five is still Unknown.
    [Fact]
    public void Reads_a_run_that_never_moved_as_measurements()
    {
        Assert.Equal(ShapeId.Continuous, ShapeOf(Run(20, 20, 20, 20, 20, 20, 20, 20, 20, 20)).Id);
    }

    [Fact]
    public void Finds_no_events_in_a_run_that_never_moved()
    {
        var pulses = PulsesOf(Run(20, 20, 20, 20, 20, 20, 20, 20, 20, 20));

        Assert.Equal(0, pulses.Count);
        Assert.Equal(0, pulses.Duty, 9);
        Assert.Null(pulses.Every);
        Assert.Null(pulses.Width);
    }

    [Fact]
    public void Reads_two_levels_as_a_state_rather_than_a_quantity()
    {
        var shape = ShapeOf(Run(Door));

        Assert.Equal(ShapeId.State, shape.Id);
        Assert.Equal(2, shape.Levels);
    }

    // The number a reader wants off a door sensor is how many times it opened.
    [Fact]
    public void Counts_the_times_it_left_the_level_it_rests_at()
    {
        Assert.Equal(3, ShapeOf(Run(Door)).Pulses!.Count);
    }

    [Fact]
    public void Says_what_share_of_the_run_was_spent_away_from_rest()
    {
        Assert.Equal(0.3, ShapeOf(Run(Door)).Pulses!.Duty, 9);
    }

    [Fact]
    public void Names_the_two_levels_it_moves_between()
    {
        var pulses = ShapeOf(Run(Door)).Pulses!;

        Assert.Equal(0, pulses.Rest, 9);
        Assert.Equal(1, pulses.Peak, 9);
    }

    // The event is whichever side the run spends less of itself on, so a link that is up all day
    // and drops twice has two events rather than eighteen.
    [Fact]
    public void Reads_a_run_that_rests_high_and_drops_as_drops()
    {
        var shape = ShapeOf(Link());

        Assert.Equal(ShapeId.State, shape.Id);
        Assert.Equal(2, shape.Pulses!.Count);
        Assert.Equal(1, shape.Pulses.Rest, 9);
        Assert.Equal(0, shape.Pulses.Peak, 9);
    }

    // Twelve distinct values, so the state branch never opens; what is left is a rest with
    // events on it, and the events are measured against the run's own scatter rather than
    // against any threshold written in units.
    [Fact]
    public void Reads_a_rest_with_events_on_it_as_pulses()
    {
        var shape = ShapeOf(PulseTrain());

        Assert.Equal(ShapeId.Pulse, shape.Id);
        Assert.Equal(12, shape.Levels);
        Assert.Equal(3, shape.Pulses!.Count);
        Assert.Equal(0.2, shape.Pulses.Duty, 9);
    }

    // The quirk in shape.ts worth naming: pulsesOf names rest from the summary's ends, and then
    // spiking replaces it with the median. They answer different questions and the difference is
    // real — 0.01 is the lowest reading in the window, 0.04 is where the meter actually sits —
    // so PulsesOf, which is spiking with the judgement removed, keeps the un-overridden answer.
    [Fact]
    public void Takes_a_pulse_runs_rest_from_the_middle_reading_not_the_lowest()
    {
        Assert.Equal(0.04, ShapeOf(PulseTrain()).Pulses!.Rest, 9);
        Assert.Equal(0.01, PulsesOf(PulseTrain()).Rest, 9);
        Assert.Equal(2.72, PulsesOf(PulseTrain()).Threshold, 9);
    }

    // The spec's case, and the reason the confirmation machine exists. A two-state signal that
    // reports a third value once has three levels, the least of them visited once, so lived()
    // refuses it and the run stops being a state machine on that one reading. Asserted as the
    // quirk it is: nothing here corrects it, and rule 7's two-cycle confirmation is what keeps
    // that single reading from firing a shapeChange alert.
    [Fact]
    public void Drops_a_two_state_signal_out_of_state_when_a_third_value_appears_once()
    {
        var shape = ShapeOf(Run(0, 0, 1, 0, 0, 1, 1, 0, 0, 2, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0));

        Assert.NotEqual(ShapeId.State, shape.Id);
        Assert.Equal(ShapeId.Pulse, shape.Id);
        Assert.Equal(3, shape.Levels);
    }

    // A boiler that steps to 95 and stays there crossed between its levels once, which is a step
    // and not a switch: the note has a better reading of a step than 'one event'. Past the state
    // branch, spiking finds a scatter of 17.5 about a median of 77.5 and nothing more than six
    // of those away from it, so there is no rest to leave.
    [Fact]
    public void Reads_a_step_that_never_came_back_as_measurements()
    {
        var boiler = new double[30];
        for (var index = 0; index < 30; index++) boiler[index] = index < 15 ? 60 : 95;

        Assert.Equal(ShapeId.Continuous, ShapeOf(Run(boiler)).Id);
    }

    // Duty is the share of READINGS, not of time, and that is the contract's rule 9. The same
    // door on wildly uneven gaps — fifteen readings in a second and a half, then a nineteen
    // second silence — still spent six of its twenty readings open.
    [Fact]
    public void Measures_duty_as_the_share_of_readings_not_of_time()
    {
        long[] gaps =
        [
            0, 100, 200, 300, 400, 500, 600, 700, 800, 900,
            1000, 1100, 1200, 1300, 1400, 1500, 20000, 20100, 20200, 20300
        ];

        Assert.Equal(0.3, ShapeOf(At(gaps, Door)).Pulses!.Duty, 9);
        Assert.Equal(0.3, ShapeOf(Run(Door)).Pulses!.Duty, 9);
    }

    // The period and the width are milliseconds, and they are the one pair of numbers that does
    // follow the clock: the same readings ten times closer together are the same duty and a
    // tenth of the period.
    [Fact]
    public void Reports_the_period_and_the_width_in_milliseconds()
    {
        long[] gaps =
        [
            0, 100, 200, 300, 400, 500, 600, 700, 800, 900,
            1000, 1100, 1200, 1300, 1400, 1500, 20000, 20100, 20200, 20300
        ];

        var quick = ShapeOf(At(gaps, Door)).Pulses!;
        var slow = ShapeOf(Run(Door)).Pulses!;

        Assert.Equal(600, quick.Every!.Value, 9);
        Assert.Equal(200, quick.Width!.Value, 9);
        Assert.Equal(6000, slow.Every!.Value, 9);
        Assert.Equal(2000, slow.Width!.Value, 9);
    }

    // A width is measured to the first reading that is back at rest, so an excursion still open
    // when the window ends has no width — not a width of zero, which would say it lasted no
    // time. The condition is SKIPPED on a null, never false.
    [Fact]
    public void Leaves_the_width_null_until_the_first_excursion_has_finished()
    {
        var pulses = PulsesOf(Run(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1));

        Assert.Equal(1, pulses.Count);
        Assert.Null(pulses.Width);
        Assert.Null(pulses.Every);
    }

    // A period is the gap from one excursion's start to the next, so one excursion has none
    // however long it lasted.
    [Fact]
    public void Leaves_the_period_null_until_a_second_excursion_starts()
    {
        var pulses = PulsesOf(Every(2 * TimeSpan.TicksPerSecond,
            0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0));

        Assert.Null(pulses.Every);
        Assert.Equal(4000, pulses.Width!.Value, 9);
    }

    // A Reading carries UtcTicks, which is 100ns, and the milliseconds are computed as a
    // division rather than a truncation so that a burst arriving inside one millisecond reports
    // the width it had instead of zero. shape.ts cannot do this — a JavaScript Date has
    // millisecond resolution and nothing finer — so this is the one place the mirror is sharper
    // than the original rather than different from it.
    [Fact]
    public void Reports_a_width_finer_than_a_millisecond()
    {
        var pulses = PulsesOf(Every(2500, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0));

        Assert.Equal(0.5, pulses.Width!.Value, 9);
    }

    // Summary refuses an empty run by returning null, so nothing can reach here with one — but
    // duty would be a division by zero and a NaN duty compared against a threshold is silently
    // false, which is the worst answer available.
    [Fact]
    public void Refuses_an_empty_run()
    {
        var summary = Statistics.Summarise(new[] { 1d, 2d })!;

        Assert.Throws<ArgumentOutOfRangeException>(
            () => Shapes.PulsesOf(ReadOnlySpan<Reading>.Empty, summary));
    }
}
