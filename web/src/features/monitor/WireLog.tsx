import { useMemo, useState } from 'react';
import { useColourLookup } from '../../lib/useColourLookup';
import { matchesFilter } from '../../lib/topicMatch';
import { useLogStore, type LogEntry } from '../../stores/logStore';
import { useSelectionStore } from '../../stores/selectionStore';
import { LogEntryRow } from './LogEntryRow';
import styles from './WireLog.module.css';

const VISIBLE_ENTRIES = 5;

export function WireLog() {
  const entries = useLogStore((state) => state.entries);
  const selected = useSelectionStore((state) => state.selected);
  const clear = useSelectionStore((state) => state.clear);

  const matching = useMemo(
    () =>
      selected ? entries.filter((entry) => entry.topic && matchesFilter(selected.filter, entry.topic)) : [],
    [entries, selected],
  );

  return (
    <>
      <div className={styles.paneHead}>
        <h2 className={styles.eyebrow}>Logs</h2>

        {selected && (
          <div className={styles.focus}>
            <span className={styles.focusTopic} data-testid="focus">
              {selected.label}
            </span>
            <button
              type="button"
              onClick={clear}
              aria-label="Clear topic selection"
              title="Clear topic selection"
            >
              ×
            </button>
          </div>
        )}
      </div>

      {!selected && (
        <p className="empty">
          Pick a topic — click a subscription chip or a tree node to see its traffic here.
        </p>
      )}

      {selected && matching.length === 0 && <p className="empty">No traffic on {selected.label} yet.</p>}

      {/* Keying on the filter remounts the list on focus change, folding it back to five. */}
      {selected && matching.length > 0 && <EntryList key={selected.filter} entries={matching} />}
    </>
  );
}

function EntryList({ entries }: { entries: LogEntry[] }) {
  const [expanded, setExpanded] = useState(false);
  const colourOf = useColourLookup();

  const shown = expanded ? entries : entries.slice(0, VISIBLE_ENTRIES);
  const hidden = entries.length - VISIBLE_ENTRIES;

  return (
    <>
      <div className={styles.log}>
        {shown.map((entry) => (
          <LogEntryRow key={entry.id} entry={entry} colour={colourOfEntry(entry, colourOf)} />
        ))}
      </div>

      {hidden > 0 && (
        <button type="button" className={styles.more} onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Show fewer' : `Show ${hidden} more`}
        </button>
      )}
    </>
  );
}

/**
 * Only a message wears a rule's colour.
 *
 * A command entry's `topic` is what the command was aimed at — a filter, possibly a wildcard, or
 * a count like '3 filters'. Handing that to the lookup would colour 'Subscribed to sensors/#'
 * with the rule for sensors/#, which reads as a message on a topic that does not exist.
 */
function colourOfEntry(entry: LogEntry, colourOf: (topic: string) => string | null) {
  const isMessage = entry.kind === 'recv' || entry.kind === 'sent';

  return isMessage && entry.topic ? colourOf(entry.topic) : null;
}
