import { numericSeries, seriesByTopic, type Series } from './series';
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

export function chartable(entries: LogEntry[], field?: string | null): Chartable {
  if (entries.length < 2) return { kind: 'none', reason: { code: 'too-few', have: entries.length } };

  const topics = new Set(entries.map((entry) => entry.topic).filter(Boolean));

  if (topics.size <= 1) {
    const series = numericSeries(entries, field);

    return series ? { kind: 'one', series } : { kind: 'none', reason: why(entries, field) };
  }

  const drawn = seriesByTopic(entries, field);
  if (drawn.length === 0) return { kind: 'none', reason: why(entries, field) };

  // One topic in the selection that charts is one line, not a set of small multiples with a
  // single member — the reader asked for a branch, but what came back is a topic.
  if (drawn.length === 1) return { kind: 'one', series: drawn[0] };

  return {
    kind: 'many',
    series: drawn.slice(0, MOST_LINES),
    more: Math.max(drawn.length - MOST_LINES, 0),
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
function why(entries: LogEntry[], field?: string | null): Reason {
  // A field the reader picked that this topic does not carry is not the topic's fault, and the
  // way out of it is a different chip rather than a different topic.
  if (field) return { code: 'no-field', field };

  const bodies = entries.filter((entry) => entry.body);
  const topics = new Set(entries.map((entry) => entry.topic).filter(Boolean)).size;

  // Only one message on the topic that carried anything at all: nothing is wrong, the run is
  // simply one message old.
  if (bodies.length < 2) return { code: 'too-few', have: bodies.length };

  return { code: 'no-numbers', sample: bodies[0].body ?? null, topics };
}
