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
    title: 'A quantity',
    about: 'Readings of something measurable — a temperature, a pressure, a voltage.',
  },
  events: {
    title: 'A switch or a pulse',
    about:
      'A run that rests somewhere and leaves it. Averaging one describes nothing that happened, so it is counted and timed instead.',
  },
  run: { title: 'Any run', about: 'True of every chart, whatever the readings are.' },
};

export const READINGS: Record<ReadingId, Reading> = {
  n: { label: 'n', what: 'How many readings are on the chart.', group: 'quantity' },
  mean: {
    label: 'mean',
    what: 'The average — every reading added up, divided by how many. One wild reading drags it.',
    group: 'quantity',
  },
  median: {
    label: 'median',
    what: 'The middle reading: half are above it, half below. A wild reading barely moves it.',
    group: 'quantity',
  },
  spread: {
    label: 'spread',
    what: 'How far a reading usually sits from the mean (σ). Small means steady, large means noisy.',
    group: 'quantity',
  },
  range: { label: 'range', what: 'The lowest reading and the highest.', group: 'quantity' },
  quartiles: {
    label: 'quartiles',
    what: 'The middle half of the readings — a quarter fall below the first, a quarter above the second.',
    group: 'quantity',
    off: true,
  },
  fences: {
    label: 'fences',
    what: 'A reading outside these is called an outlier: one and a half box-widths past the quartiles.',
    group: 'quantity',
    off: true,
  },
  shape: {
    label: 'shape',
    what: 'Which distribution the readings resemble — normal, uniform, exponential — when they resemble one.',
    group: 'quantity',
  },
  trend: {
    label: 'trend',
    what: 'Which way the run is going, and how fast, but only when the drift is bigger than its own noise.',
    group: 'quantity',
  },
  step: {
    label: 'step',
    what: 'Where the run moved from one level to another, and when — a valve opening, a heater coming on.',
    group: 'quantity',
  },
  cycle: {
    label: 'cycle',
    what: 'How many readings the run takes to repeat itself: a thermostat, a pump, a compressor.',
    group: 'quantity',
  },
  outliers: {
    label: 'outliers',
    what: 'How many readings fall outside the fences. Each is ringed on the line.',
    group: 'quantity',
  },
  levels: {
    label: 'levels',
    what: 'The level the run rests at, and the level it goes to.',
    group: 'events',
  },
  events: {
    label: 'events',
    what: 'How many separate times it left the level it rests at.',
    group: 'events',
  },
  duty: {
    label: 'duty',
    what: 'What share of the readings were spent away from rest — a door open a third of the day.',
    group: 'events',
  },
  width: { label: 'width', what: 'How long one excursion lasts, middle case.', group: 'events' },
  period: {
    label: 'period',
    what: 'How long from one excursion starting to the next.',
    group: 'events',
  },
  every: {
    label: 'every',
    what: 'The middle gap between arrivals, and how far the gaps stray from it.',
    group: 'run',
  },
  offScale: {
    label: 'off scale',
    what: "Readings the plot's range could not hold. They are drawn on the edge they went past, never dropped.",
    group: 'run',
  },
  window: {
    label: 'window',
    what: "How much of the topic's history is on the chart, when it holds more than one can draw.",
    group: 'run',
  },
  skipped: {
    label: 'skipped',
    what: 'Messages in view that carried no reading and were stepped over.',
    group: 'run',
  },
  silence: {
    label: 'silence',
    what: 'How long the topic has been quiet, once that is longer than its own rhythm allows.',
    group: 'run',
  },
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
