import type { Fit } from '../../lib/distribution';
import { duration, short } from '../../lib/format';
import type { Domain } from '../../lib/scale';
import type { Pulses, Shape } from '../../lib/shape';
import type { Cadence, Change, Summary } from '../../lib/stats';
import styles from './TrafficChart.module.css';

/**
 * One reading off the run, in a cell of its own.
 *
 * `value` is null when the run has nothing to say here — the cell stays and shows a dash, so
 * every other reading is exactly where it was a second ago.
 */
type Slot = {
  label: string;
  value: string | null;
  title: string;
  /** 'stat' counts something, 'reading' says something about it, 'alarm' interrupts. */
  tone: 'stat' | 'reading' | 'alarm';
};

/**
 * What the run adds up to, under the chart that draws it.
 *
 * Every reading has a fixed place. The note used to be a row of items that came and went with
 * the traffic — a run that grew an outlier pushed the pace along the line, a step appearing
 * shunted everything after it onto the next line, and a value going from 9.9 to 10.1 nudged its
 * neighbours sideways. Nothing about those movements was information, and all of them landed on
 * a reader who was trying to read one number. So the slots are fixed: the labels never move, the
 * digits are one width, and only the values under them change.
 *
 * Which slots those are follows the shape of the run. A mean, a deviation and a trend describe a
 * temperature; under a door sensor they describe nothing that ever happened — the door was never
 * 0.3 open, and it has no trend. A switch is counted and timed instead, and a counter is read as
 * the rate it is climbing at, since its value is an accident of when the device last restarted.
 */
export function ChartNote({
  summary,
  shape,
  domain,
  fit,
  pace,
  skipped,
  sparse = false,
  step = null,
  stepAt = null,
  period = null,
  of = null,
  silence = null,
  quartiles = false,
}: {
  summary: Summary;
  /** What kind of run this is, which decides which of the readings below mean anything. */
  shape: Shape;
  /** The range the plot was drawn in, which is not always the run's own. */
  domain: Domain;
  fit: Fit | null;
  pace: Cadence | null;
  skipped: number;
  /** More of the run was stepped over than was read, which the reader has to be told. */
  sparse?: boolean;
  /** Where the run moved from one level to another, when it did. */
  step?: Change | null;
  /** When that happened, which is what makes it something to go and look at. */
  stepAt?: Date | null;
  /** How many readings the run takes to repeat itself, when it repeats itself. */
  period?: number | null;
  /** How long the run really is, when the chart is drawing a window of it. */
  of?: number | null;
  /** How long the topic has been quiet, when that is longer than its own rhythm allows. */
  silence?: number | null;
  /** The middle half and the fences around it, for a reader who came for the numbers. */
  quartiles?: boolean;
}) {
  const counted =
    shape.id === 'state' || shape.id === 'pulse'
      ? events(summary, shape.pulses, pace)
      : shape.id === 'counter'
        ? climbing(summary, shape.rate, shape.wraps)
        : measurements(summary, quartiles);

  const read: Slot[] = [
    ...(shape.id === 'continuous'
      ? [
          shapeSlot(summary, fit, trend(summary, pace), step),
          direction(summary, trend(summary, pace), step),
          stepped(step, stepAt),
          cycles(period, pace),
          {
            label: 'outliers',
            value: `${summary.outliers.length}`,
            title: `readings outside ${short(summary.fences.low)} to ${short(summary.fences.high)}, one and a half box-widths past the quartiles`,
            tone: 'reading' as const,
          },
        ]
      : []),
    arrivals(pace),
    offScale(domain),
    {
      label: 'window',
      // A window is not the whole run, and 'n 500' beside a history of five thousand, without
      // saying which five hundred, would be the chart cropping the topic quietly.
      value: of === null ? 'all' : `${summary.n} of ${of}`,
      title:
        of === null
          ? 'every reading the log holds on this topic is charted'
          : 'the log holds the rest; a chart this size cannot draw them and the note would be redone over all of them on every arrival',
      tone: 'reading',
    },
    {
      label: 'skipped',
      // Never silent about what was left out: a chart quietly dropping messages is a chart
      // lying about how much of the topic it is showing. Past half, it is not a run with gaps
      // in it — it is a topic that mostly sends something else, and the line over these numbers
      // is a scattering rather than a signal. That is worth interrupting for.
      value: `${skipped}`,
      title: sparse
        ? `${skipped} of the messages in view carried no reading — most of this topic is not on the chart`
        : `${skipped} message${skipped === 1 ? '' : 's'} in view carried no reading and were stepped over`,
      tone: sparse ? 'alarm' : 'reading',
    },
    {
      label: 'silence',
      // The one item here about the topic rather than the readings, and the only one worth
      // interrupting for: a sensor that published every second and has not published for a
      // minute is either dead or unreachable, and nothing else in the column would say so.
      value: silence !== null ? duration(silence) : null,
      title:
        silence !== null && pace
          ? `no reading for ${duration(silence)}, on a topic that had been publishing every ${duration(pace.every)}`
          : 'how long the topic has been quiet, once that is longer than its own rhythm allows',
      tone: 'alarm',
    },
  ];

  return (
    <figcaption className={styles.note} data-testid="note" data-shape={shape.id}>
      {[...counted, ...read].map((slot) => (
        <div
          key={slot.label}
          className={styles.slot}
          data-slot={slot.label}
          data-tone={slot.tone}
          data-empty={slot.value === null ? '' : undefined}
          title={slot.title}
        >
          <span className={styles.slotLabel}>{slot.label}</span>
          {/* The value carries its own title as well as the cell: cut short by the fixed column,
              it is the half a reader will reach for. */}
          <span
            className={styles.slotValue}
            data-testid={`reading-${slot.label}`}
            title={slot.value ?? undefined}
          >
            {slot.value ?? '—'}
          </span>
        </div>
      ))}
    </figcaption>
  );
}

/** What the readings are, counted and averaged — the readings of a quantity. */
function measurements(summary: Summary, quartiles: boolean): Slot[] {
  const slots: Slot[] = [
    { label: 'n', value: `${summary.n}`, title: `${summary.n} readings charted`, tone: 'stat' },
    { label: 'mean', value: short(summary.mean), title: 'x̄ — the average of the readings', tone: 'stat' },
    { label: 'median', value: short(summary.median), title: 'M — the middle reading', tone: 'stat' },
    {
      label: 'spread',
      value: short(summary.sd),
      title: 'σ — standard deviation, over all readings held',
      tone: 'stat',
    },
    {
      label: 'range',
      // A dash between a negative low and its high reads as arithmetic; the word does not.
      value:
        summary.low < 0 || summary.high < 0
          ? `${short(summary.low)} to ${short(summary.high)}`
          : `${short(summary.low)}–${short(summary.high)}`,
      title: `lowest to highest · quartiles ${short(summary.q1)} and ${short(summary.q3)}`,
      tone: 'stat',
    },
  ];

  if (quartiles) {
    slots.push({
      label: 'quartiles',
      value: `${short(summary.q1)}–${short(summary.q3)}`,
      title: 'half the readings are between these two',
      tone: 'stat',
    });
    slots.push({
      label: 'fences',
      value: `${short(summary.fences.low)}–${short(summary.fences.high)}`,
      title: 'a reading outside these is marked an outlier',
      tone: 'stat',
    });
  }

  return slots;
}

/**
 * What a switch or a pulse train adds up to.
 *
 * Not a mean: the average of a door is a number the door has never been, and the average of a
 * flow meter that idles at zero and spikes to three is a flow that never flowed. What a reader
 * wants off one of these is how many times it happened, how long it lasted, how often it comes
 * and what share of the time it is on — every one of which the mean destroys.
 */
function events(summary: Summary, pulses: Pulses, pace: Cadence | null): Slot[] {
  return [
    { label: 'n', value: `${summary.n}`, title: `${summary.n} readings charted`, tone: 'stat' },
    {
      label: 'levels',
      value: `${short(pulses.rest)} → ${short(pulses.peak)}`,
      title: `the level the run rests at, and the level it goes to — counted across ${short(pulses.threshold)}`,
      tone: 'stat',
    },
    {
      label: 'events',
      value: `${pulses.count}`,
      title: `separate excursions past ${short(pulses.threshold)} — a mean over these would describe none of them`,
      tone: 'reading',
    },
    {
      label: 'duty',
      // Two figures, not one: 'a third of the time' is the reading, and the percentage is the
      // number someone will want to quote.
      value: `${Math.round(pulses.duty * 100)}%`,
      title: `share of the readings spent past ${short(pulses.threshold)}`,
      tone: 'reading',
    },
    {
      label: 'width',
      value: pulses.width === null ? null : duration(pulses.width),
      title:
        pulses.width === null
          ? 'how long an excursion lasts, once one of them has finished'
          : 'middle time from an excursion starting to the run being back at rest',
      tone: 'reading',
    },
    {
      label: 'period',
      value: pulses.every === null ? null : duration(pulses.every),
      title:
        pulses.every === null
          ? 'the middle time from one excursion to the next, once there are two of them'
          : `middle time from one excursion starting to the next${pace ? `, on a topic publishing every ${duration(pace.every)}` : ''}`,
      tone: 'reading',
    },
  ];
}

/**
 * What a running total adds up to, which is its slope and nothing else.
 *
 * The value of a packet counter says when the device last restarted. The rate says what it is
 * doing, and a rate is the one reading a chart of the raw total makes hardest to see: every
 * counter looks like the same straight line whatever it is counting.
 */
function climbing(summary: Summary, rate: number | null, wraps: number): Slot[] {
  return [
    { label: 'n', value: `${summary.n}`, title: `${summary.n} readings charted`, tone: 'stat' },
    {
      label: 'rate',
      value: rate === null ? null : `${short(rate)}/s`,
      title:
        rate === null
          ? 'how fast the total is climbing, once the readings are spread over any time at all'
          : `the total climbs ${short(rate)} a second — the value itself only says when the device last restarted`,
      tone: 'reading',
    },
    {
      label: 'counted',
      value: short(summary.high - summary.low),
      title: 'how much the total rose across the readings on the chart',
      tone: 'stat',
    },
    {
      label: 'at',
      value: short(summary.high),
      title: 'the newest reading of the total',
      tone: 'stat',
    },
    {
      label: 'restarts',
      value: wraps === 0 ? null : `${wraps}`,
      title:
        wraps === 0
          ? 'times the total went back to the beginning, if it did'
          : `the total went back to the beginning ${wraps} time${wraps === 1 ? '' : 's'}; the rate steps over those`,
      tone: wraps === 0 ? 'reading' : 'alarm',
    },
  ];
}

/**
 * Readings the plot's range could not hold.
 *
 * The chart pins them to the edge and marks each one, and this is the count in words. Between
 * them, a reader can never mistake a line lying flat along the top of the plot for a run that
 * genuinely sat at the maximum.
 */
function offScale(domain: Domain): Slot {
  const outside = domain.over + domain.under;

  return {
    label: 'off scale',
    value: outside === 0 ? null : `${domain.over > 0 ? `↑${domain.over}` : ''}${domain.under > 0 ? ` ↓${domain.under}` : ''}`.trim(),
    title:
      outside === 0
        ? `every reading fits between ${short(domain.low)} and ${short(domain.high)}`
        : `${outside} reading${outside === 1 ? '' : 's'} outside ${short(domain.low)} to ${short(domain.high)}, drawn on the edge they went past — switch the range to 'ends' to see them where they are`,
    tone: outside === 0 ? 'reading' : 'alarm',
  };
}

/**
 * The shape the readings fall into, when that is a fair description of them.
 *
 * A run that is going somewhere is described by where it is going, not by the shape its readings
 * make on the way: a draining battery is a perfect uniform distribution, and saying so is true
 * and useless. A run with a step in it is two shapes and neither of them is one the fit has a
 * name for. The direction, or the step, is the reading that means something.
 */
function shapeSlot(summary: Summary, fit: Fit | null, drift: Slot | null, step: Change | null): Slot {
  const named = fit && !drifting(drift) && !step;

  return {
    label: 'shape',
    // '≈', because the test returns 'not enough evidence to reject' rather than 'is' — at these
    // sample sizes the difference between those two is the whole claim.
    value: named ? `≈ ${fit.name}` : null,
    // The claim is a test result, so the test is on the label rather than in a footnote nobody
    // would find: what was measured, and what it had to beat.
    title: named
      ? `consistent with a ${fit.name} distribution over ${summary.n} readings — Kolmogorov–Smirnov at 5%, D ${short(fit.d)} under ${short(fit.critical)}`
      : 'the distribution the readings fall into, when the run is not going somewhere instead',
    tone: 'reading',
  };
}

/**
 * Which way the run is going.
 *
 * Empty where the run stepped: a slope drawn through a stair fits neither of the levels it
 * joins, and the mean of the two is a reading that never happened. The step beside it is the
 * description of that run, and this slot says so by having nothing to add.
 */
function direction(summary: Summary, drift: Slot | null, step: Change | null): Slot {
  if (step || !drift) {
    return {
      label: 'trend',
      value: null,
      title: step
        ? 'the run holds two levels rather than one direction — see the step beside this'
        : `no direction the readings' own scatter of ${short(summary.sd)} does not account for`,
      tone: 'reading',
    };
  }

  return drift;
}

/**
 * Where the run moved from one level to another, and when.
 *
 * A valve opened, a heater came on, a scale was reloaded. The when is what makes it something
 * to go and look at rather than a number to nod at.
 */
function stepped(step: Change | null, stepAt: Date | null): Slot {
  const when = stepAt ? ` at ${stepAt.toLocaleTimeString('en-GB', { hour12: false })}` : '';

  return {
    label: 'step',
    value: step ? `${step.shift > 0 ? '+' : '−'}${short(Math.abs(step.shift))}${when}` : null,
    title: step
      ? `the run holds two levels — ${short(step.before)} before, ${short(step.after)} after — and the split between them clears the scatter about both`
      : 'where the run moved from one level to another, when it did',
    tone: 'reading',
  };
}

/** A machine that repeats itself. Nothing else here would say so: a cycling sensor has an
 *  ordinary mean, an ordinary spread, and a trend of nothing.
 *
 *  The count of readings and the time they take, in that order — the count is what was measured
 *  and the time is what a reader chasing a compressor actually wants. Both are short enough to
 *  sit on one line of the cell; the label on it spells out which is which. */
function cycles(period: number | null, pace: Cadence | null): Slot {
  return {
    label: 'cycle',
    value: period === null ? null : `${period}${pace ? ` · ${duration(period * pace.every)}` : ' readings'}`,
    title:
      period === null
        ? 'how many readings the run takes to repeat itself, when it repeats itself'
        : `the run resembles itself most strongly ${period} readings apart${pace ? `, which at this pace is ${duration(period * pace.every)}` : ''}`,
    tone: 'reading',
  };
}

/** How often the topic publishes, and how far its gaps stray from that. */
function arrivals(pace: Cadence | null): Slot {
  return {
    label: 'every',
    value: pace ? `${duration(pace.every)}${pace.jitter > 0 ? ` ±${duration(pace.jitter)}` : ''}` : null,
    title: pace
      ? `middle gap between arrivals${pace.jitter > 0 ? ', and how far the gaps stray from it' : ', evenly spaced'}`
      : 'the middle gap between arrivals, once the run has a rhythm to measure',
    tone: 'reading',
  };
}

/** Whether the trend slot is holding a direction rather than 'unchanged'. */
const drifting = (drift: Slot | null) => !!drift && drift.value !== 'unchanged';

/**
 * Which way the run is going, when it is going anywhere.
 *
 * The threshold is the run's own noise: a drift smaller than the readings' spread is a line
 * through a cloud, and calling that 'rising' would put a trend on every sensor in the building.
 */
function trend(summary: Summary, pace: Cadence | null): Slot | null {
  if (summary.sd === 0) {
    return { label: 'trend', value: 'unchanged', title: 'every reading identical', tone: 'reading' };
  }

  const drift = summary.slope * (summary.n - 1);
  if (Math.abs(drift) <= summary.sd) return null;

  const perMinute = pace ? summary.slope * (60_000 / pace.every) : null;
  const rate = perMinute === null ? `${short(summary.slope)}/reading` : `${short(perMinute)}/min`;

  return {
    label: 'trend',
    value: `${summary.slope > 0 ? 'rising' : 'falling'} ${rate.replace('-', '')}`,
    title: `least-squares trend — ${short(Math.abs(drift))} across the run, against a spread of ${short(summary.sd)}`,
    tone: 'reading',
  };
}
