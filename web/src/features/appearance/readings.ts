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
    about: 'Something measurable: a temperature, a pressure, a voltage.',
  },
  events: {
    title: 'A switch or a pulse',
    about: 'A run that rests somewhere and leaves it. Counted, not averaged.',
  },
  run: { title: 'Any run', about: 'True of every chart, whatever the readings are.' },
};

export const READINGS: Record<ReadingId, Reading> = {
  n: { label: 'n', what: 'Readings on the chart.', group: 'quantity' },
  mean: {
    label: 'mean',
    what: 'The average. One wild reading drags it.',
    group: 'quantity',
  },
  median: {
    label: 'median',
    what: 'The middle reading. A wild one barely moves it.',
    group: 'quantity',
  },
  spread: {
    label: 'spread',
    what: 'How far a reading usually sits from the mean (σ).',
    group: 'quantity',
  },
  range: { label: 'range', what: 'Lowest reading to highest.', group: 'quantity' },
  quartiles: {
    label: 'quartiles',
    what: 'The middle half of the readings.',
    group: 'quantity',
    off: true,
  },
  fences: {
    label: 'fences',
    what: 'Past these, a reading counts as an outlier.',
    group: 'quantity',
    off: true,
  },
  shape: {
    label: 'shape',
    what: 'Which distribution the readings resemble.',
    group: 'quantity',
  },
  trend: {
    label: 'trend',
    what: 'Which way the run is going, and how fast.',
    group: 'quantity',
  },
  step: {
    label: 'step',
    what: 'Where the run changed level, and when.',
    group: 'quantity',
  },
  cycle: {
    label: 'cycle',
    what: 'How many readings the run takes to repeat itself.',
    group: 'quantity',
  },
  outliers: {
    label: 'outliers',
    what: 'Readings outside the fences, ringed on the line.',
    group: 'quantity',
  },
  levels: { label: 'levels', what: 'The level it rests at, and the one it goes to.', group: 'events' },
  events: { label: 'events', what: 'How many separate times it left rest.', group: 'events' },
  duty: { label: 'duty', what: 'What share of the readings sat away from rest.', group: 'events' },
  width: { label: 'width', what: 'How long one excursion lasts.', group: 'events' },
  period: { label: 'period', what: 'From one excursion to the next.', group: 'events' },
  every: { label: 'every', what: 'The usual gap between arrivals, and its jitter.', group: 'run' },
  offScale: {
    label: 'off scale',
    what: "Readings past the plot's range, drawn on its edge.",
    group: 'run',
  },
  window: {
    label: 'window',
    what: "How much of the topic's history is on the chart.",
    group: 'run',
  },
  skipped: { label: 'skipped', what: 'Messages in view that carried no reading.', group: 'run' },
  silence: { label: 'silence', what: 'How long the topic has been quiet.', group: 'run' },
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
