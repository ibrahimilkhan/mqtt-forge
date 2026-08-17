import { memo, type CSSProperties } from 'react';
import type { ColourRule } from '../../lib/topicColour';
import { useComposeStore } from '../../stores/composeStore';
import type { LogEntry } from '../../stores/logStore';
import styles from './WireLog.module.css';

// Entries are immutable, so memoising means a new arrival re-renders only one row.
export const LogEntryRow = memo(function LogEntryRow({
  entry,
  rule,
}: {
  entry: LogEntry;
  /** The colour rule covering this entry's topic, or null when none does. */
  rule?: ColourRule | null;
}) {
  const load = useComposeStore((state) => state.load);

  // Only an arrival can be sent back. A command entry carries the filter it was aimed at, which
  // may be a wildcard, and an outcome rather than a payload — neither is publishable. The whole
  // row is the target rather than a small icon, since re-sending what just arrived is the
  // common move in a fake console.
  const reload =
    entry.topic && entry.kind === 'recv'
      ? () =>
          load({
            topic: entry.topic!,
            payload: entry.body,
            mode: entry.mode,
            qos: entry.qos ?? 0,
            retain: entry.retain ?? false,
          })
      : undefined;

  return (
    <div
      className={styles.entry}
      data-kind={entry.kind}
      data-testid="entry"
      // The left edge reads this. Unset when no rule covers the topic, so the edge falls back
      // to the colour of the entry's kind rather than to an empty one.
      style={rule ? ({ '--rule-colour': rule.colour } as CSSProperties) : undefined}
      {...(reload && {
        role: 'button',
        tabIndex: 0,
        title: 'Load into publish',
        'aria-label': `Load ${entry.topic} into publish`,
        // A click that ends a drag over the payload is someone copying it, not re-sending it.
        // Keyboard activation skips the check: a selection left elsewhere is not this row's.
        onClick: () => {
          if (window.getSelection()?.isCollapsed !== false) reload();
        },
        onKeyDown: (event: React.KeyboardEvent) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            reload();
          }
        },
      })}
    >
      {/* Time, QoS, retained, size: one line of furniture, read left to right, before the topic
          and the payload that are what the row is actually about. An arrival adds no verb to it —
          the pane holds nothing but arrivals, so there is nothing for one to tell apart. */}
      <div className={styles.entryHead} data-testid="head">
        <span>{entry.at.toLocaleTimeString('en-GB', { hour12: false })}</span>
        {entry.verb && (
          <span className={styles.verb} data-testid="verb">
            {entry.verb}
          </span>
        )}
        {entry.stamps && (
          <span className={styles.stamps}>
            {entry.stamps.map((stamp) => (
              <span key={stamp} className={styles.stamp} data-stamp={stamp}>
                {stamp}
              </span>
            ))}
          </span>
        )}
      </div>

      {entry.topic && (
        /* The rule paints the topic itself rather than a mark beside it, so a scrolling log
           reads by colour without a column of marks down its edge. The title names the filter:
           with rules overlapping, which one won is what the colour leaves open. */
        <div
          className={styles.topic}
          data-testid="topic"
          style={rule ? { color: rule.colour } : undefined}
          title={rule ? `Coloured by ${rule.filter}` : undefined}
        >
          <Topic topic={entry.topic} />
        </div>
      )}

      {entry.body && (
        <div className={styles.body} data-testid="body">
          {entry.body}
        </div>
      )}
    </div>
  );
});

// Splits into segments so the '/' separators can be dimmed.
function Topic({ topic }: { topic: string }) {
  return (
    <>
      {topic.split('/').map((segment, index) => (
        <span key={index}>
          {index > 0 && (
            <span className={styles.sep} data-testid="sep">
              /
            </span>
          )}
          {segment}
        </span>
      ))}
    </>
  );
}
