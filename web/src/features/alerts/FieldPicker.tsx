import { useId, useMemo, useState, type CSSProperties } from 'react';
import panel from '../../styles/panel.module.css';
import { useTopicTreeStore } from '../../stores/topicTreeStore';
import { fieldsIn, parseBody, samplesFor, type PayloadField } from './payloadFields';
import styles from './FieldPicker.module.css';

/**
 * A body, and the paths in it, offered where a field path is typed.
 *
 * The other half of the topic picker's argument. A path is the field in this form with the
 * highest chance of being wrong and the lowest chance of anybody noticing: a wrong filter shows
 * up as a rule that never fires and so does a wrong path, except that a path also has a syntax
 * nobody has met before and a six-level ceiling nobody has been told about. Typed from memory it
 * is wrong often enough that the panel keeps a counter for it.
 *
 * So: take a document the reader can see, list what is in it, and let them press the one they
 * mean. The document comes from the broker where the broker has one — the rule's own filter says
 * which topics count, and the newest body on each of them is already in the tree store — and from
 * the reader's clipboard where it does not, which is the case at three in the morning when the
 * plant is off and the rule is being written from a spec.
 *
 * Nothing here writes to the draft except through `onPick`. Pressing a row puts one string in the
 * Field box; the box stays a box, and a path this cannot offer is still a path that can be typed.
 */

/** Which body the list is being built from. */
type Source = { kind: 'live'; topic: string } | { kind: 'pasted' };

export function FieldPicker({
  filter,
  onPick,
  onClose,
}: {
  /** The rule's own topic filter, which is what decides whose messages are worth offering. */
  filter: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const root = useTopicTreeStore((state) => state.root);

  // A filter that is still being typed matches nothing useful, so an empty one asks for
  // everything rather than for nothing: the reader has opened this to look at bodies.
  const samples = useMemo(
    () => samplesFor(root, filter.trim() === '' ? '#' : filter.trim()),
    [root, filter],
  );

  const [source, setSource] = useState<Source>(() =>
    samples.length > 0 ? { kind: 'live', topic: samples[0].topic } : { kind: 'pasted' },
  );
  const [pasted, setPasted] = useState('');

  /**
   * The live body this is showing, if it is showing one.
   *
   * The topic filter is a box above this picker and can be typed into while it is open, so the
   * topic this was opened on can stop being a topic the rule covers — and a `find` that came back
   * empty left the picker drawing a heading, a select and nothing else, with no word about why.
   * The newest of whatever is left stands in; when nothing is left, the paste box does.
   */
  const live =
    source.kind === 'live'
      ? (samples.find((one) => one.topic === source.topic) ?? samples[0] ?? null)
      : null;
  const pasting = live === null;

  const body = pasting ? (pasted.trim() === '' ? null : pasted) : live.payload;

  const parsed = body === null ? null : parseBody(body);
  const { fields, skipped } = useMemo(
    () => (parsed === null ? { fields: [] as PayloadField[], skipped: 0 } : fieldsIn(parsed)),
    [parsed],
  );

  // Unique per picker, so the two labels in here point at their own boxes however many editors
  // a future panel decides to open at once.
  const id = useId();

  return (
    <div className={styles.picker} role="group" aria-label="Fields in a message">
      <div className={styles.head}>
        {samples.length > 0 && (
          <div className={styles.source}>
            <label htmlFor={`${id}-topic`}>From</label>
            <select
              id={`${id}-topic`}
              value={live?.topic ?? ''}
              onChange={(event) =>
                setSource(
                  event.target.value === ''
                    ? { kind: 'pasted' }
                    : { kind: 'live', topic: event.target.value },
                )
              }
            >
              {samples.map((one) => (
                <option key={one.topic} value={one.topic}>
                  {one.topic}
                </option>
              ))}
              {/* The escape hatch sits in the same list as the topics, because it answers the same
                  question — which document are we looking at — and a separate toggle beside the
                  list would be a second control for one decision. */}
              <option value="">a body I paste in</option>
            </select>
          </div>
        )}

        <button type="button" className="ghost" onClick={onClose}>
          Close
        </button>
      </div>

      {pasting && (
        <div className={styles.paste}>
          <label htmlFor={`${id}-body`}>Paste one message</label>
          <textarea
            id={`${id}-body`}
            rows={4}
            value={pasted}
            spellCheck={false}
            placeholder={'{"temp": 21.5, "pump": {"state": "RUN"}}'}
            onChange={(event) => setPasted(event.target.value)}
          />
          {pasted.trim() !== '' && parsed === null && (
            <p className={panel.fault}>
              That is not a JSON document. A body a field can be read out of opens with{' '}
              <code>&#123;</code> or <code>[</code>.
            </p>
          )}
        </div>
      )}

      {!pasting && (
        // What was loaded, as it arrived. The list underneath is the useful form of it, but a
        // reader picking a path out of a message they cannot see is picking on trust.
        <pre className={styles.body}>{pretty(live.payload)}</pre>
      )}

      {parsed !== null && fields.length === 0 && (
        <p className="empty">
          This document carries no value a rule could read — everything in it is deeper than six
          levels, or named in a way no path can reach.
        </p>
      )}

      {fields.length > 0 && (
        <>
          <p className={styles.hint}>Press a value to write its path into Field.</p>
          <div className={styles.rows}>
            {fields.map((field) => (
              <button
                key={field.path}
                type="button"
                className={styles.pick}
                style={{ '--depth': field.depth - 1 } as CSSProperties}
                onClick={() => onPick(field.path)}
              >
                <span className={styles.path}>{field.path}</span>
                <span className={styles.kind} data-kind={field.kind}>
                  {field.kind}
                </span>
                <span className={styles.val}>{field.preview}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {skipped > 0 && (
        <p className={styles.hint}>
          {skipped} {skipped === 1 ? 'name is' : 'names are'} not listed: a key holding a{' '}
          <code>.</code>, <code>[</code> or <code>]</code> cannot be written as a path.
        </p>
      )}
    </div>
  );
}

/** The body laid out, or exactly as it arrived when it is not a document after all. */
function pretty(body: string): string {
  const held = parseBody(body);

  return held === null ? body : JSON.stringify(held, null, 2);
}
