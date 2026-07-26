import { memo } from 'react';
import type { LogEntry } from '../../stores/logStore';
import styles from './WireLog.module.css';

// Entries never change once written, so memoising means a new arrival re-renders one row.
export const LogEntryRow = memo(function LogEntryRow({ entry }: { entry: LogEntry }) {
  return (
    <div className={styles.entry} data-kind={entry.kind} data-testid="entry">
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
                <span key={stamp} className={styles.stamp}>
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

// Splits the topic into MQTT segments so the separators can be dimmed.
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
