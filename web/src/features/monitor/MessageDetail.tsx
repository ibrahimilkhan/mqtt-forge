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

  return (
    // One wrapper. The window's body is a grid of a single row, so two children here would put
    // the properties in a track of no height and lose them under the payload.
    <div className={styles.detail}>
      <dl className={styles.rows}>
        {entry.topic && (
          <Row label="topic">
            <Topic topic={entry.topic} />
          </Row>
        )}
        <Row label="at">{when(entry.at)}</Row>
        {entry.qos !== undefined && <Row label="qos">{entry.qos}</Row>}
        {entry.retain !== undefined && <Row label="retained">{entry.retain ? 'yes' : 'no'}</Row>}
        {entry.size !== undefined && <Row label="size">{weight(entry)}</Row>}
        {rule && (
          <Row label="colour">
            <span style={{ color: rule.colour }}>{rule.filter}</span>
          </Row>
        )}
      </dl>

      <Payload entry={entry} />
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={styles.row}>
      <dt>{label}</dt>
      <dd>{children}</dd>
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
 * What it weighed, and what that is in the characters on screen when the two differ.
 *
 * A hex body is two characters and a space for every byte, so a reader looking at 3071 characters
 * of dump and a row stamped '1.0kB' is owed the arithmetic rather than left to do it.
 */
function weight(entry: LogEntry) {
  const bytes = `${entry.size} bytes`;
  const shown = entry.body?.length ?? 0;

  return entry.mode === 'hex' ? `${bytes}, ${shown} characters of hex` : bytes;
}
