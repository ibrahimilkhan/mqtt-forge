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
  | 'field'
  | 'into'
  | 'up'
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
  what: { title: 'What is drawn', about: 'Which readings the plot is of.' },
  range: { title: 'The range', about: 'How much height the run gets.' },
  view: { title: 'The view', about: 'How the run is drawn, and how to save it.' },
};

export const CONTROLS: Record<ControlId, Control & { group: ControlGroup }> = {
  field: {
    label: 'temp, hum, …',
    group: 'what',
    what: 'Each number in a JSON body, by name. Opens on the busiest.',
    when: 'When a body carries more than one number.',
  },
  into: {
    label: 'radios ›',
    group: 'what',
    what: 'A group of fields. Opens it; the title says how many.',
    when: 'When a body nests its numbers.',
  },
  up: {
    label: '← radios',
    group: 'what',
    what: 'Back out of a group. It names the one you are in.',
    when: 'After opening one.',
  },
  fewer: {
    label: '⌄',
    group: 'what',
    what: 'Puts the field chips away, and brings them back.',
    when: 'When a body carries more than one number.',
  },
  branch: {
    label: '← all',
    group: 'what',
    what: 'Back to every topic in the branch.',
    when: 'After clicking into one of its plots.',
  },
  open: {
    label: '⤢',
    group: 'what',
    what: 'Floats the chart over the console. Escape puts it back.',
  },
  auto: {
    label: 'auto',
    group: 'range',
    what: 'Measurements take Range above; pulses take their extremes.',
  },
  time: {
    label: 'time',
    group: 'view',
    what: 'The readings in the order they arrived.',
  },
  dist: {
    label: 'dist',
    group: 'view',
    what: 'The same readings as a distribution.',
  },
  csv: {
    label: 'csv',
    group: 'view',
    what: 'Saves the charted readings as CSV.',
  },
};

export const CONTROL_IDS = Object.keys(CONTROLS) as ControlId[];

/** What each range prints on its chip. Short enough for a row that shares a 200px pane. */
export const CHIP: Record<ScaleId, string> = { extremes: 'ends', typical: 'mid', log: 'log' };

/** The range chips, which already describe themselves in the scale catalogue. */
export const RANGE_CHIPS: ReadonlyArray<{ id: ScaleId; label: string; hint: string }> = (
  Object.keys(SCALES) as ScaleId[]
).map((id) => ({ id, label: CHIP[id], hint: SCALES[id].hint }));
