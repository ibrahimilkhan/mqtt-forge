import { useLogStore } from '../../stores/logStore';
import { LogEntryRow } from './LogEntryRow';
import styles from './WireLog.module.css';

export function WireLog() {
  const entries = useLogStore((state) => state.entries);

  return (
    <>
      <div className={styles.paneHead}>
        <h2 className={styles.eyebrow}>Wire log</h2>
      </div>

      {entries.length === 0 ? (
        <p className="empty">Nothing on the wire yet. Connect to a broker, then publish a message.</p>
      ) : (
        <div className={styles.log}>
          {entries.map((entry) => (
            <LogEntryRow key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </>
  );
}
