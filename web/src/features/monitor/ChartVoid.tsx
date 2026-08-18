import type { Reason } from '../../lib/chartable';
import styles from './TrafficChart.module.css';

/** Enough of a body to recognise your own payload; past that it is a wall, not evidence. */
const SHOW = 160;

/**
 * Why there is no chart, in terms of what the topic actually sent.
 *
 * The pane used to say one thing here — 'a line needs one topic sending numbers' — for four
 * different situations, three of which pass on their own within a second or two. A reader who
 * saw it had no way to know whether to wait, to pick a field, to pick another topic, or to go and
 * look at the device. So each reason says its own sentence, and the two that the reader can act
 * on hand them the thing to act with: the field chips, or the topic's own newest message.
 */
export function ChartVoid({
  reason,
  fields,
  onField,
}: {
  reason: Reason;
  /** The numeric fields the run does carry, for the reason that is about a field that it doesn't. */
  fields: string[];
  onField: (field: string) => void;
}) {
  if (reason.code === 'too-few') {
    return (
      <p className="empty" data-testid="unchartable" data-reason="too-few">
        {reason.have === 0
          ? 'Nothing has arrived on this topic yet.'
          : 'One message so far. A line needs two — the next one draws it.'}
      </p>
    );
  }

  if (reason.code === 'no-field') {
    return (
      <div className="empty" data-testid="unchartable" data-reason="no-field">
        <p>
          Nothing on this run carries <b>{reason.field}</b>.
        </p>
        {fields.length > 0 && (
          <p className={styles.voidFields}>
            {/* The way out is a different chip, so the chips are here rather than only in the
                row above — a reader who has just been told their field is empty should not have
                to go looking for the list of ones that are not. */}
            {fields.map((name) => (
              <button
                key={name}
                type="button"
                className={styles.chip}
                aria-label={`Chart ${name}`}
                onClick={() => onField(name)}
              >
                {name}
              </button>
            ))}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="empty" data-testid="unchartable" data-reason="no-numbers">
      <p>
        {reason.topics > 1
          ? `Nothing numeric on the ${reason.topics} topics under this selection.`
          : 'This topic is not sending numbers.'}
      </p>
      {/* The evidence for the sentence above. Nine readers in ten recognise their own payload
          here and know at once whether the chart is wrong or the device is. */}
      {reason.sample && (
        <pre className={styles.voidSample} data-testid="void-sample">
          {reason.sample.length > SHOW ? `${reason.sample.slice(0, SHOW)}…` : reason.sample}
        </pre>
      )}
    </div>
  );
}
