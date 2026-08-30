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
  what: { title: 'What is drawn', about: 'Which readings the plot is of, and how much room it gets.' },
  range: {
    title: 'The range',
    about: 'How much of the plot’s height goes on the run’s range.',
  },
  view: { title: 'The view, and taking it away', about: 'How the run is drawn, and how to get it out.' },
};

export const CONTROLS: Record<ControlId, Control & { group: ControlGroup }> = {
  field: {
    label: 'temp, hum, …',
    group: 'what',
    what: 'Each numeric field of a JSON body, by name. It opens on the busiest.',
    when: 'Only when the bodies carry more than one number.',
  },
  into: {
    label: 'radios ›',
    group: 'what',
    what: 'A group of fields rather than one of them. It opens the group; its title says how many are inside.',
    when: 'Only when a body nests its numbers.',
  },
  up: {
    label: '← radios',
    group: 'what',
    what: 'Back out of a group of fields. It names the group you are standing in.',
    when: 'Only after opening one.',
  },
  fewer: {
    label: 'hide',
    group: 'what',
    what: 'Puts the field chips away. The one chip left behind names what is charted, and brings them back.',
    when: 'Only when the bodies carry more than one number.',
  },
  branch: {
    label: '← all',
    group: 'what',
    what: 'Back out to every topic under the branch.',
    when: 'Only after clicking into one of a branch’s small plots.',
  },
  open: {
    label: '⤢',
    group: 'what',
    what: 'Floats the chart over the console, still live around it. Escape puts it back.',
  },
  auto: {
    label: 'auto',
    group: 'range',
    what: 'Measurements take Range above; pulses always take their extremes.',
  },
  time: {
    label: 'time',
    group: 'view',
    what: 'The readings in the order they arrived.',
  },
  dist: {
    label: 'dist',
    group: 'view',
    what: 'The same readings as a distribution — what the run usually does.',
  },
  csv: {
    label: 'csv',
    group: 'view',
    what: 'Saves the charted readings as CSV, into the folder set below.',
  },
};

export const CONTROL_IDS = Object.keys(CONTROLS) as ControlId[];

/** What each range prints on its chip. Short enough for a row that shares a 200px pane. */
export const CHIP: Record<ScaleId, string> = { extremes: 'ends', typical: 'mid', log: 'log' };

/** The range chips, which already describe themselves in the scale catalogue. */
export const RANGE_CHIPS: ReadonlyArray<{ id: ScaleId; label: string; hint: string }> = (
  Object.keys(SCALES) as ScaleId[]
).map((id) => ({ id, label: CHIP[id], hint: SCALES[id].hint }));
