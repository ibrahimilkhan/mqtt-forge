import { numericSeries, seriesFromRuns, type Series } from './series';
import type { LogEntry } from '../stores/logStore';

/**
 * What there is to draw for a selection, and — when there is nothing — why.
 *
 * The chart used to answer this with one sentence for four different situations: 'a line needs
 * one topic sending numbers'. It was shown when a branch of the tree was picked, which is the
 * ordinary way to use the tree; when the first message of a run had arrived and the second had
 * not; and when a topic really did send text. Three of those are temporary and one is not, and
 * the reader had no way to tell which they were looking at — so the chart read as something that
 * worked sometimes.
 *
 * Now the selection is resolved to one of three answers, and every one of them is specific: one
 * line, several lines, or a reason with the topic's own last message under it.
 */
export type Chartable =
  | { kind: 'one'; series: Series }
  /** A wildcard covering several topics: one small plot each, on its own scale. */
  | { kind: 'many'; series: Series[]; more: number }
  | { kind: 'none'; reason: Reason };

export type Reason =
  /** The run is one message long, or none. A line needs two. */
  | { code: 'too-few'; have: number }
  /** Messages arrived and none of them carried a number. `sample` is the newest body. */
  | { code: 'no-numbers'; sample: string | null; topics: number }
  /** A field was picked that this topic does not carry. Offer the ones it does. */
  | { code: 'no-field'; field: string };

/**
 * How many lines a wildcard is drawn as.
 *
 * Past this the plots are shorter than the labels on them. The rest are still in the log and the
 * count says they are there, which is the same bargain the window makes on a long run.
 */
export const MOST_LINES = 6;

/**
 * Takes the traffic as one run per topic, which is how the log holds it and how a chart of a
 * branch draws it. It used to take one flat sequence and group it again here, and the log had
 * to merge and sort the runs to produce that sequence — work whose only purpose was to be
 * undone one call later.
 */
export function chartable(runs: readonly LogEntry[][], field?: string | null): Chartable {
  let total = 0;
  for (const run of runs) total += run.length;

  if (total < 2) return { kind: 'none', reason: { code: 'too-few', have: total } };

  if (runs.length <= 1) {
    const series = numericSeries(runs[0] ?? [], field);

    return series ? { kind: 'one', series } : { kind: 'none', reason: why(runs, field) };
  }

  const drawn = seriesFromRuns(runs, field, MOST_LINES);
  if (drawn.length === 0) return { kind: 'none', reason: why(runs, field) };

  // One topic in the selection that charts is one line, not a set of small multiples with a
  // single member — the reader asked for a branch, but what came back is a topic.
  if (drawn.length === 1) return { kind: 'one', series: drawn[0] };

  return {
    kind: 'many',
    series: drawn,
    // The topics under the branch that are not drawn, which is what the line beneath the plots
    // says out loud. It counts every one of them rather than only the ones that would chart:
    // knowing which of ten thousand topics carry numbers means building a series for each, and
    // that is the work this stopped doing. The two counts agree wherever a branch is one kind
    // of device, which is the ordinary shape of a branch.
    more: Math.max(runs.length - drawn.length, 0),
  };
}

/**
 * Why nothing could be drawn, in terms of what the topic actually sent.
 *
 * The newest body travels with the reason: 'nothing here is a number' is an accusation, and
 * showing the message beside it is the evidence — nine times in ten the reader recognises their
 * own payload and knows immediately whether to pick a field, a different topic, or to go and fix
 * the device.
 */
function why(runs: readonly LogEntry[][], field?: string | null): Reason {
  // A field the reader picked that this topic does not carry is not the topic's fault, and the
  // way out of it is a different chip rather than a different topic.
  if (field) return { code: 'no-field', field };

  let bodies = 0;
  let newest: LogEntry | null = null;

  for (const run of runs) {
    for (const entry of run) {
      if (!entry.body) continue;

      bodies++;
      // Ids only go up, so the newest body across the runs is the highest of them — the runs
      // are each newest first but are not in any order relative to one another.
      if (newest === null || entry.id > newest.id) newest = entry;
    }
  }

  // Only one message on the topic that carried anything at all: nothing is wrong, the run is
  // simply one message old.
  if (bodies < 2) return { code: 'too-few', have: bodies };

  return { code: 'no-numbers', sample: newest?.body ?? null, topics: runs.length };
}
