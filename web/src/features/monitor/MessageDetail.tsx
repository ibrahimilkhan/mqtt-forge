import { useMemo, useState } from 'react';
import { checkJson, formatJson } from '../../lib/payload';
import { useRuleLookup } from '../../lib/useRuleLookup';
import type { LogEntry } from '../../stores/logStore';
import { Topic } from './LogEntryRow';
import styles from './MessageDetail.module.css';

/**
 * One arrival, opened out: what it is, and the whole of what it carried.
 *
 * The row it came from is a line in a run and shows what a line can — a time, a topic, four lines
 * of payload. This is the same message with the room to answer the questions the row cannot: how
 * many bytes was that actually, was it retained, what is the fortieth line of it.
 *
 * The message is frozen. The window keeps the entry it was opened on, so the log behind it may
 * evict it, the selection may move, the broker may drop — and this goes on saying what arrived.
 */
export function MessageDetail({ entry }: { entry: LogEntry }) {
  const ruleOf = useRuleLookup();
  const rule = entry.topic ? ruleOf(entry.topic) : null;
  const rest = unsaid(entry);

  return (
    // One wrapper. The window's body is a grid of a single row, so two children here would put
    // the summary in a track of no height and lose it under the payload.
    <div className={styles.detail}>
      {/* One line for what this message is: the word 'topic', the topic itself at reading size,
          and the moment it landed held against the far end.

          The word stays. A path is not always obviously a path — 'front', 'meter', a single
          segment with no slash in it at all — and the first line of a window has to be readable
          without the run behind it to compare against. The date needs no word of its own: nothing
          else on this screen looks like a timestamp.

          Held apart rather than stacked, because they answer two different questions and a reader
          opening a window an hour after the fact is asking the second one. They wrap together
          when the window is too narrow to hold both, and the date keeps the right edge either
          way.

          The topic carries its rule's colour, the same as the row it was opened from. The window
          used to be drawn in the console's plain ink while the row behind it was green, and the
          two never read as one message. */}
      <div className={styles.head} data-testid="summary">
        <div className={styles.line}>
          {entry.topic && <span className={styles.label}>topic</span>}
          {entry.topic && (
            <div className={styles.topic} data-copy style={rule ? { color: rule.colour } : undefined}>
              <Topic topic={entry.topic} />
            </div>
          )}

          {/* data-copy on both, because this console selects nothing by default and the exceptions
              are listed one at a time — these were a dt/dd pair, which was on that list. A topic is
              the most-copied string on the screen, and a window it could not be taken out of would
              be a window that had quietly stopped being useful. */}
          <time className={styles.at} dateTime={entry.at.toISOString()} data-copy>
            {when(entry.at)}
          </time>
        </div>

        {(rest.length > 0 || entry.retain === false || rule) && (
          <p className={styles.unsaid}>
            {/* The one thing on this line that is a state rather than a measurement, so it is
                drawn as a state: the same box the chips upstairs are drawn in, standing where the
                bar had nothing to put. A message that was retained wears its chip up there with
                the others; one that was not has no chip up there at all, because the log stamps
                nothing for it — and the answer to a question every other answer boxes should not
                be the one that arrives as a loose word. */}
            {entry.retain === false && <span className={styles.stamp}>not retained</span>}

            {rest.length > 0 && <span>{rest.join(' \u00b7 ')}</span>}

            {/* The rule, named and painted, where the row can only carry it as a hover. No word
                in front of it: it is drawn in the colour the topic two lines up is drawn in,
                which is the whole of the answer, and a console that labels its own colours is a
                console explaining itself. */}
            {rule && (
              <span style={{ color: rule.colour }} title={`Coloured by ${rule.filter}`}>
                {rule.filter}
              </span>
            )}
          </p>
        )}
      </div>

      <Payload entry={entry} />
    </div>
  );
}

/**
 * The whole payload, formatted where formatting is what it is.
 *
 * Three answers, and the reader can always get back to the fourth. A body that is not text at all
 * — hex — is shown as it arrived, because reformatting a byte dump is not a thing. A body that
 * does not begin with a brace or a bracket is shown as it arrived, because `JSON.parse` accepts a
 * bare number and calling `21.5` a JSON document helps nobody. What is left is meant to be JSON:
 * pretty-printed if it parses, with one control back to the exact characters that arrived — and
 * if it does not parse, shown raw with the reason it did not, which is the same sentence the
 * publish form gives about a draft.
 */
function Payload({ entry }: { entry: LogEntry }) {
  const [raw, setRaw] = useState(false);

  const read = useMemo(() => {
    const body = entry.body ?? '';
    if (!body) return null;
    if (entry.mode === 'hex') return { text: body, why: null, formatted: false };

    const first = body.trimStart()[0];
    if (first !== '{' && first !== '[') return { text: body, why: null, formatted: false };

    const why = checkJson(body);

    return why === null
      ? { text: formatJson(body), why: null, formatted: true }
      : { text: body, why, formatted: false };
  }, [entry.body, entry.mode]);

  if (!read) return null;

  return (
    <>
      {read.why && <p className={styles.fault}>{read.why}</p>}

      {/* A div rather than a p: a double-click inside a paragraph is claimed by the console's own
          prose selection, and this is a payload somebody may well want to take a word out of. */}
      <div className={styles.payload} data-testid="window-body" data-copy>
        {read.formatted && raw ? entry.body : read.text}
      </div>

      {read.formatted && (
        <button
          type="button"
          className={styles.toggle}
          aria-pressed={!raw}
          title={raw ? 'Show it formatted' : 'Show exactly what arrived'}
          onClick={() => setRaw(!raw)}
        >
          json
        </button>
      )}
    </>
  );
}

/**
 * The moment it landed, to the millisecond.
 *
 * The row shows a time and no date, which is right for a line in a run that arrived while you
 * were watching. A message opened an hour later is a different question, so this answers it in
 * full — and the milliseconds are the part a reader comparing two arrivals actually needs.
 */
const when = (at: Date) =>
  `${at.toLocaleString('en-GB', { hour12: false })}.${String(at.getMilliseconds()).padStart(3, '0')}`;

/**
 * What the chips in the bar cannot say.
 *
 * The bar wears the log's own stamps, and those are drawn to be glanced at in a scrolling run.
 * The weight is one of them, and what a message weighed is not a second question owed a second
 * answer: it is said once, in the chip, and saying it again underneath in more words was the old
 * table refusing to be deleted.
 *
 * What the chip cannot say is a hex body's arithmetic — which is not the weight but the reason
 * the weight and the screen disagree — and whether a message was retained, which is a state
 * rather than a measurement and is drawn beside this as a chip of its own.
 *
 * Said only where it is actually missing upstairs, which is what keeps this from being a table:
 * an ordinary retained reading returns nothing at all and draws no line, because the chips have
 * already said the whole of it.
 */
function unsaid(entry: LogEntry): string[] {
  const said: string[] = [];

  // A hex body is two characters and a space for every byte, so a reader looking at 3071
  // characters of dump beside a chip stamped '1.0kb' is owed the arithmetic rather than left to
  // do it. This is still the only place in the console that reconciles the two.
  if (entry.mode === 'hex') said.push(`${entry.body?.length ?? 0} characters of hex`);

  return said;
}
