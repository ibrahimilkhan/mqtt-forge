import { memo } from 'react';
import { useComposeStore } from '../../stores/composeStore';
import type { LogEntry } from '../../stores/logStore';
import styles from './WireLog.module.css';

// Entries are immutable, so memoising means a new arrival re-renders only one row.
export const LogEntryRow = memo(function LogEntryRow({ entry }: { entry: LogEntry }) {
  const load = useComposeStore((state) => state.load);

  // Only a message can be sent back. A command entry carries the filter it was aimed at, which
  // may be a wildcard, and an outcome rather than a payload — neither is publishable. The whole
  // row is the target rather than a small icon, since re-sending what just arrived is the
  // common move in a fake console.
  const reload =
    entry.topic && (entry.kind === 'recv' || entry.kind === 'sent')
      ? () =>
          load({
            topic: entry.topic!,
            payload: entry.body,
            qos: entry.qos ?? 0,
            retain: entry.retain ?? false,
          })
      : undefined;

  return (
    <div
      className={styles.entry}
      data-kind={entry.kind}
      data-testid="entry"
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
      <div className={styles.entryHead}>
        <span>{entry.at.toLocaleTimeString('en-GB', { hour12: false })}</span>
        <span className={styles.verb} data-testid="verb">
          {entry.verb}
        </span>
      </div>

      {entry.topic && (
        <div className={styles.topic} data-testid="topic">
          <Topic topic={entry.topic} />
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
      )}

      {entry.body && <div className={styles.body}>{entry.body}</div>}
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
