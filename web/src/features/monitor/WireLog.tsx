import { useMemo, useState } from 'react';
import type { ColourRule } from '../../lib/topicColour';
import { useRuleLookup } from '../../lib/useRuleLookup';
import { matchesFilter } from '../../lib/topicMatch';
import { useLogStore, type LogEntry } from '../../stores/logStore';
import { useSelectionStore } from '../../stores/selectionStore';
import { LogEntryRow } from './LogEntryRow';
import styles from './WireLog.module.css';

const VISIBLE_ENTRIES = 5;

export function WireLog() {
  const entries = useLogStore((state) => state.entries);
  const selected = useSelectionStore((state) => state.selected);

  const matching = useMemo(
    () => (selected ? entries.filter((entry) => carriesTraffic(entry, selected.filter)) : []),
    [entries, selected],
  );

  return (
    <>
      {/* The only heading the pane has, and it is off screen: the entries start at the pane's
          edge. Every row names its own topic, so a strip naming the selection above them was
          furniture over a list that already says what it is about. */}
      <h2 className="srOnly">Logs</h2>

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
  const ruleOf = useRuleLookup();

  const shown = expanded ? entries : entries.slice(0, VISIBLE_ENTRIES);
  const hidden = entries.length - VISIBLE_ENTRIES;

  return (
    <>
      <div className={styles.log}>
        {shown.map((entry) => (
          <LogEntryRow key={entry.id} entry={entry} rule={ruleForEntry(entry, ruleOf)} />
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
 * The pane answers one question — what has moved on this topic — so only messages belong in it.
 *
 * A command entry's `topic` is what the command was aimed at: a filter, possibly a wildcard, or
 * a count like '3 filters'. Matching that against the selection reads as traffic that never
 * happened — 'Subscribed to sensors/#' would sit under a selected sensors/# looking like an
 * arrival on a topic no broker ever published to.
 */
function carriesTraffic(entry: LogEntry, filter: string): boolean {
  const isMessage = entry.kind === 'recv' || entry.kind === 'sent';

  return isMessage && !!entry.topic && matchesFilter(filter, entry.topic);
}

/** A rule colours the topic a message landed on; a command entry never reaches the rows. */
function ruleForEntry(entry: LogEntry, ruleOf: (topic: string) => ColourRule | null) {
  return entry.topic ? ruleOf(entry.topic) : null;
}
