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
export type ControlId = 'field' | 'auto' | 'time' | 'dist' | 'csv' | 'open' | 'branch';

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
    about: 'How much of the plot’s height goes on the run’s range. Each of these is a whole chip row of its own.',
  },
  view: { title: 'The view, and taking it away', about: 'How the same run is drawn, and how to get it out of the console.' },
};

export const CONTROLS: Record<ControlId, Control & { group: ControlGroup }> = {
  field: {
    label: 'temp, hum, …',
    group: 'what',
    what: 'One message can carry a whole environment, so each numeric field of a JSON body is offered by name. The chart opens on whichever of them is doing the most.',
    when: 'Only when the bodies carry more than one number.',
  },
  branch: {
    label: '← all',
    group: 'what',
    what: 'Back out to every topic under the branch, after clicking into one of them.',
    when: 'Only after you have clicked a row of a branch’s small plots.',
  },
  open: {
    label: '⤢',
    group: 'what',
    what: 'Lifts the chart out of its column and floats it over three fifths of the window, leaving the console readable — and live — around it. Escape puts it back.',
  },
  auto: {
    label: 'auto',
    group: 'range',
    what: 'Lets the readings decide: measurements take whatever Range above says, while a switch, a pulse or a counter always takes its extremes, because clipping a pulse shaves off the signal.',
  },
  time: {
    label: 'time',
    group: 'view',
    what: 'The readings in the order they arrived — what the run has been doing.',
  },
  dist: {
    label: 'dist',
    group: 'view',
    what: 'The same readings as a distribution — how often each value came up, which is what the run usually does rather than what it did.',
  },
  csv: {
    label: 'csv',
    group: 'view',
    what: 'Copies the readings on the chart to the clipboard as CSV — a header, then one row per reading with its time in full. It copies rather than downloads, so it can go straight into a spreadsheet or a notebook.',
  },
};

export const CONTROL_IDS = Object.keys(CONTROLS) as ControlId[];

/** What each range prints on its chip. Short enough for a row that shares a 200px pane. */
export const CHIP: Record<ScaleId, string> = { extremes: 'ends', typical: 'mid', log: 'log' };

/** The range chips, which already describe themselves in the scale catalogue. */
export const RANGE_CHIPS: ReadonlyArray<{ id: ScaleId; label: string; hint: string }> = (
  Object.keys(SCALES) as ScaleId[]
).map((id) => ({ id, label: CHIP[id], hint: SCALES[id].hint }));
