import { SCALES, type ScaleId } from '../../lib/scale';

/**
 * The controls over a chart, and what each of them does.
 *
 * The chip row reads `auto ends mid log | time dist csv`. Every one of those is three or four
 * characters, which is right for a row that has to fit a pane two hundred pixels wide and wrong
 * for a reader meeting it the first time — and the only explanation each had was a `title`, which
 * is a thing you have to already suspect is there before you can find it. That is the same
 * argument this codebase used against a row whose whole surface was a click target.
 *
 * So the chips stay short and the panel carries the words, the way the readings under the plot
 * already work. Both read this catalogue, so the label on a chip and the label beside its
 * explanation cannot drift apart.
 */
export type ControlId =
  | 'body'
  | 'field'
  | 'into'
  | 'up'
  | 'along'
  | 'fewer'
  | 'auto'
  | 'time'
  | 'dist'
  | 'csv'
  | 'open'
  | 'branch';

type Control = {
  /** Exactly what the control shows, so the panel and the chart cannot disagree. */
  label: string;
  what: string;
  /** Shown only in some runs; the panel says when, since a reader may never have seen it. */
  when?: string;
};

export const CONTROL_GROUPS = ['what', 'range', 'view'] as const;

export type ControlGroup = (typeof CONTROL_GROUPS)[number];

export const CONTROL_GROUP_TITLES: Record<ControlGroup, { title: string; about: string }> = {
  what: { title: 'Data', about: 'Which values are plotted.' },
  range: { title: 'Range', about: 'Vertical scaling.' },
  view: { title: 'View', about: 'Display mode and export.' },
};

export const CONTROLS: Record<ControlId, Control & { group: ControlGroup }> = {
  body: {
    label: 'body',
    group: 'what',
    what: 'Plots the raw payload as a number.',
    when: 'When a topic sends both plain numbers and JSON.',
  },
  field: {
    label: 'temp, hum, …',
    group: 'what',
    what: 'Plots a named JSON field. Defaults to the most active.',
    when: 'When the payload has several numeric fields.',
  },
  into: {
    label: 'radios ›',
    group: 'what',
    what: 'Opens a nested group; the tooltip shows its size.',
    when: 'When the payload has nested fields.',
  },
  up: {
    label: '← radios',
    group: 'what',
    what: 'Returns to the parent group.',
    when: 'Inside a nested group.',
  },
  along: {
    label: '3 →',
    group: 'what',
    what: 'Count of hidden field chips; scrolls to them.',
    when: 'When the chips overflow the pane.',
  },
  fewer: {
    label: '⌄',
    group: 'what',
    what: 'Shows or hides the field chips.',
    when: 'When the payload has several numeric fields.',
  },
  branch: {
    label: '← all',
    group: 'what',
    what: 'Returns to all topics in the branch.',
    when: 'After opening a single plot.',
  },
  open: {
    label: '⤢',
    group: 'what',
    what: 'Expands the chart over the console. Esc restores it.',
  },
  auto: {
    label: 'auto',
    group: 'range',
    what: 'Measurements use the selected range; pulses use their extremes.',
  },
  time: {
    label: 'time',
    group: 'view',
    what: 'Readings in arrival order.',
  },
  dist: {
    label: 'dist',
    group: 'view',
    what: 'Readings as a distribution.',
  },
  csv: {
    label: 'csv',
    group: 'view',
    what: 'Exports the plotted readings as CSV.',
  },
};

export const CONTROL_IDS = Object.keys(CONTROLS) as ControlId[];

/** What each range prints on its chip. Short enough for a row that shares a 200px pane. */
export const CHIP: Record<ScaleId, string> = { extremes: 'ends', typical: 'mid', log: 'log' };

/** The range chips, which already describe themselves in the scale catalogue. */
export const RANGE_CHIPS: ReadonlyArray<{ id: ScaleId; label: string; hint: string }> = (
  Object.keys(SCALES) as ScaleId[]
).map((id) => ({ id, label: CHIP[id], hint: SCALES[id].hint }));
