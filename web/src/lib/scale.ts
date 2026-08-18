import type { Summary } from './stats';

/**
 * How much of a run's range the plot's height is spent on.
 *
 * A topic that reads 1, 2, 3 all day and then once reads 4000 is the ordinary case, not the odd
 * one: a counter wraps, a sensor faults, a gateway reports a raw register by mistake. Scaled to
 * the extremes, the thousand readings the reader came for are pressed into the bottom pixel of
 * the pane and the chart says nothing at all about them.
 *
 * So the range is the reader's to choose, and neither answer is the right one on its own —
 * 'extremes' is the honest picture of a run whose peak *is* the event, and 'typical' is the
 * readable picture of a run whose peak is a fault sitting on top of the signal.
 */
export const SCALES = {
  extremes: {
    label: 'Extremes — every reading inside the plot',
    hint: 'the lowest and highest readings are the top and bottom of the plot',
  },
  typical: {
    label: 'Typical — scaled to where the readings mostly are',
    hint: 'scaled to the middle of the run; readings past the edge are pinned to it and counted',
  },
  log: {
    label: 'Logarithmic — each decade the same height',
    hint: 'ten to a hundred takes the same height as a hundred to a thousand; positive runs only',
  },
} as const;

export type ScaleId = keyof typeof SCALES;

export const SCALE_DEFAULT: ScaleId = 'typical';

/**
 * The band of values the plot's height covers, and what was left outside it.
 *
 * `low` and `high` are the edges. `over` and `under` count the readings that did not fit, which
 * the chart draws pinned to the edge and the note reports: a scale that quietly dropped the very
 * reading someone is looking for would be worse than an unreadable one.
 */
export type Domain = {
  low: number;
  high: number;
  /** Positions are taken on a log10 axis, so each decade takes the same height. */
  log: boolean;
  over: number;
  under: number;
  /** Which of the three this actually is — a mode that could not apply falls back, and says so. */
  mode: ScaleId;
};

/** Below this the middle half is a couple of readings and a robust range is a guess. */
export const ENOUGH_FOR_A_ROBUST_RANGE = 8;

/**
 * The band to draw a run in.
 *
 * 'typical' is Tukey's fences — the middle half of the readings, widened by one and a half
 * box-widths either side. That is the same line the note already draws between spread and an
 * outlier, so a reading pinned to the edge here is exactly a reading ringed as an outlier there,
 * and the two halves of the chart cannot disagree about what belongs to the run.
 *
 * Where the middle half is a single value — 1, 2, 3 repeating has quartiles a hair apart — the
 * fences collapse onto it and would clip the whole run. Deviation about the median catches those,
 * and a run with no scatter at all falls back to its extremes, which are then all it has.
 */
export function domainFor(values: number[], summary: Summary, mode: ScaleId): Domain {
  const extremes = { low: summary.low, high: summary.high, log: false, over: 0, under: 0 };

  // Nothing to choose between: one value is one line, at whatever height the plot puts it.
  if (summary.high === summary.low) return { ...extremes, mode: 'extremes' };

  if (mode === 'log') {
    // A log axis has no place for zero and no answer for a negative, and pretending otherwise
    // silently moves readings. A run that goes to zero is drawn on its extremes instead.
    if (summary.low <= 0) return { ...extremes, mode: 'extremes' };

    return { ...extremes, log: true, mode: 'log' };
  }

  if (mode === 'extremes' || summary.n < ENOUGH_FOR_A_ROBUST_RANGE) {
    return { ...extremes, mode: 'extremes' };
  }

  const band = robustBand(values, summary);
  if (band === null) return { ...extremes, mode: 'extremes' };

  // Never wider than the run itself: a fence past the highest reading would leave empty plot
  // above the line, which reads as headroom the sensor has rather than as arithmetic.
  const low = Math.max(band.low, summary.low);
  const high = Math.min(band.high, summary.high);

  // The band has to be a band, and it has to be narrower than the run — a band that reaches both
  // ends is the extremes wearing another name, and saying 'typical' over it would tell the reader
  // that something was left out when nothing was.
  if (high <= low || (low <= summary.low && high >= summary.high)) {
    return { ...extremes, mode: 'extremes' };
  }

  return {
    low,
    high,
    log: false,
    over: values.filter((value) => value > high).length,
    under: values.filter((value) => value < low).length,
    mode: 'typical',
  };
}

/** Tukey's fences, or — where the middle half has no width to measure — departures from the middle. */
function robustBand(values: number[], summary: Summary): { low: number; high: number } | null {
  const iqr = summary.q3 - summary.q1;
  if (iqr > 0) return { low: summary.q1 - 1.5 * iqr, high: summary.q3 + 1.5 * iqr };

  // The fences met, so more than half the run is one value and there is no box to measure a
  // fence against. What is left to go on is how far the other readings stray from it: sort the
  // departures, drop the furthest twentieth, and the largest that remains is the reach of the
  // band. A run whose only departure is the spike itself has nothing left after the drop, and
  // falls through to the extremes below — which for a flat line and one spike is the honest
  // picture anyway.
  const strays = values.map((value) => Math.abs(value - summary.median)).sort((a, b) => a - b);
  // Rounded outwards: at two dozen readings a twentieth is half of one, and rounding that inwards
  // would drop an ordinary reading to make room for nothing.
  const reach = strays[Math.ceil((strays.length - 1) * (1 - EDGE))];

  return reach > 0 ? { low: summary.median - reach, high: summary.median + reach } : null;
}

/** The share of a run's furthest departures the band is allowed to leave outside it. */
const EDGE = 0.05;

/**
 * Where a value sits in the domain, from 0 at the low edge to 1 at the high one.
 *
 * Clamped, so a reading past an edge is drawn *on* it rather than outside the plot. The chart
 * rings those and the note counts them — a pinned reading is visible as pinned, never as a
 * reading that happened to sit at the extreme.
 */
export function positionIn(domain: Domain, value: number): number {
  const [low, high, at] = domain.log
    ? [Math.log10(domain.low), Math.log10(domain.high), Math.log10(Math.max(value, Number.MIN_VALUE))]
    : [domain.low, domain.high, value];

  if (high === low) return 0.5;

  return Math.min(Math.max((at - low) / (high - low), 0), 1);
}

/** Whether the plot had to pin this reading to an edge to draw it. */
export const pinned = (domain: Domain, value: number) => value > domain.high || value < domain.low;
