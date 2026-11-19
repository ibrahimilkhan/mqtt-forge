/**
 * Every reading the note under a chart can make, what it means, and when it applies.
 *
 * The note prints a dozen short labels — `n`, `spread`, `duty`, `fences` — and a label that short
 * is only readable by someone who already knows what it stands for. The titles on the cells say
 * so on hover, which is no help to anyone who does not know there is anything to hover over. So
 * the catalogue lives here, in one place, and the Chart panel prints the whole of it beside a
 * switch for each: a reader who does not want a reading can put it away, and a reader who does
 * not recognise one can find out what it is without leaving the console.
 */
export type ReadingId =
  | 'n'
  | 'mean'
  | 'median'
  | 'spread'
  | 'range'
  | 'quartiles'
  | 'fences'
  | 'shape'
  | 'trend'
  | 'step'
  | 'cycle'
  | 'outliers'
  | 'levels'
  | 'events'
  | 'duty'
  | 'width'
  | 'period'
  | 'every'
  | 'offScale'
  | 'scale'
  | 'window'
  | 'skipped'
  | 'silence';

/** Which kind of run a reading belongs to, which is also how the panel groups them. */
export type ReadingGroup = 'quantity' | 'events' | 'run';

type Reading = {
  /** What the note prints. Short on purpose — the panel is where it gets explained. */
  label: string;
  /** What it means, in words a reader who has never seen it before can act on. */
  what: string;
  group: ReadingGroup;
  /**
   * Off until the reader asks for it.
   *
   * The two quartile readings are the numbers behind the fences the chart already draws, and most
   * readers never need them spelled out — but the switch beside them is right there.
   */
  off?: true;
};

export const READING_GROUPS: Record<ReadingGroup, { title: string; about: string }> = {
  quantity: {
    title: 'Measurements',
    about: 'Continuous values such as temperature, pressure or voltage.',
  },
  events: {
    title: 'Switches and pulses',
    about: 'Signals with a resting level. Counted, not averaged.',
  },
  run: { title: 'All charts', about: 'Apply to every chart.' },
};

export const READINGS: Record<ReadingId, Reading> = {
  n: { label: 'n', what: 'Number of readings.', group: 'quantity' },
  mean: {
    label: 'mean',
    what: 'Arithmetic mean. Sensitive to outliers.',
    group: 'quantity',
  },
  median: {
    label: 'median',
    what: 'Middle value. Robust to outliers.',
    group: 'quantity',
  },
  spread: {
    label: 'spread',
    what: 'Standard deviation (σ).',
    group: 'quantity',
  },
  range: { label: 'range', what: 'Minimum to maximum.', group: 'quantity' },
  quartiles: {
    label: 'quartiles',
    what: 'Interquartile range (Q1–Q3).',
    group: 'quantity',
    off: true,
  },
  fences: {
    label: 'fences',
    what: 'Outlier thresholds.',
    group: 'quantity',
    off: true,
  },
  shape: {
    label: 'shape',
    what: 'Closest-fitting distribution.',
    group: 'quantity',
  },
  trend: {
    label: 'trend',
    what: 'Direction and rate of change.',
    group: 'quantity',
  },
  step: {
    label: 'step',
    what: 'Level shifts and when they occurred.',
    group: 'quantity',
  },
  cycle: {
    label: 'cycle',
    what: 'Repeat period, in readings.',
    group: 'quantity',
  },
  outliers: {
    label: 'outliers',
    what: 'Readings beyond the fences, circled on the plot.',
    group: 'quantity',
  },
  levels: { label: 'levels', what: 'Resting and active levels.', group: 'events' },
  events: { label: 'events', what: 'Number of departures from rest.', group: 'events' },
  duty: { label: 'duty', what: 'Share of readings away from rest.', group: 'events' },
  width: { label: 'width', what: 'Duration of a single excursion.', group: 'events' },
  period: { label: 'period', what: 'Time between excursions.', group: 'events' },
  every: { label: 'every', what: 'Typical arrival interval and jitter.', group: 'run' },
  offScale: {
    label: 'off scale',
    what: 'Readings outside the plot range, drawn at its edge.',
    group: 'run',
  },
  scale: {
    label: 'scale',
    what: 'Shown when the selected range is unavailable, with the fallback used.',
    group: 'run',
  },
  window: {
    label: 'window',
    what: 'Portion of the topic history on the chart.',
    group: 'run',
  },
  skipped: { label: 'skipped', what: 'Messages in view without a numeric value.', group: 'run' },
  silence: { label: 'silence', what: 'Time since the last message.', group: 'run' },
};

export const READING_IDS = Object.keys(READINGS) as ReadingId[];

/**
 * Whether a reading is drawn.
 *
 * `chosen` holds only what the reader has actually set, so a reading nobody has touched follows
 * the catalogue — and a later release that adds one does not need every stored preference
 * rewritten to know what to do with it.
 */
export const showsReading = (
  id: ReadingId,
  chosen: Partial<Record<ReadingId, boolean>>,
): boolean => chosen[id] ?? !READINGS[id].off;
