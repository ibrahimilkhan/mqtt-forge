import { useMemo, useState } from 'react';
import type { ColourRule } from '../../lib/topicColour';
import { useRuleLookup } from '../../lib/useRuleLookup';
import { matchesFilter } from '../../lib/topicMatch';
import { useLogStore, type LogEntry } from '../../stores/logStore';
import { useSelectionStore } from '../../stores/selectionStore';
import { LogEntryRow } from './LogEntryRow';
import { TrafficChart } from './TrafficChart';
import styles from './WireLog.module.css';

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

      {/* Keying on the filter remounts the list on focus change, folding it back to the newest. */}
      {selected && matching.length > 0 && <EntryList key={selected.filter} entries={matching} />}
    </>
  );
}

function EntryList({ entries: live }: { entries: LogEntry[] }) {
  const [expanded, setExpanded] = useState(false);
  const [held, setHeld] = useState<LogEntry[] | null>(null);
  const ruleOf = useRuleLookup();

  // Held, the pane keeps drawing the run it was drawing; the log behind it carries on filling.
  // Reading a value while the row it is in is being replaced is the oldest complaint about
  // consoles, and stopping the log to fix it throws away the traffic you were there for.
  const entries = held ?? live;

  // Ids only go up, so what has arrived since is what is newer than the newest one held.
  const arrived = held ? live.filter((entry) => entry.id > held[0].id).length : 0;

  // The newest alone, until asked. A topic under traffic overwrites its own value rather than
  // adding to it, so what a run of rows mostly shows is the same reading several times over —
  // the one that is current is what the pane is for, and the history behind it is a click away.
  const shown = expanded ? entries : entries.slice(0, 1);

  // What the log still holds on this topic, which is what says whether there is history to open
  // and how far back it goes. Not the whole log: the pane only ever answers for the selection.
  const history = `${entries.length} in history`;

  return (
    <>
      <div className={styles.log}>
        {shown.map((entry) => (
          <LogEntryRow key={entry.id} entry={entry} rule={ruleForEntry(entry, ruleOf)} />
        ))}
      </div>

      {/* Under the newest reading and over the count: the value now, the shape behind it, and
          then how much of that shape the log still holds. Draws nothing unless the entries in
          view are one topic's numbers, which is the only run a single line can honestly draw. */}
      <TrafficChart entries={entries} />

      <div className={styles.foot}>
        {/* A lone entry is already all of them, so the count states itself rather than offering
            to open onto nothing. */}
        {entries.length > 1 ? (
          <button
            type="button"
            className={styles.history}
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? 'Show fewer' : history}
          </button>
        ) : (
          <p className={styles.history}>{history}</p>
        )}

        {/* A count of nothing is not news: while nothing has arrived behind the hold, the
            control says only that it is holding. */}
        <button
          type="button"
          className={styles.hold}
          aria-pressed={held !== null}
          aria-label={
            held
              ? arrived > 0
                ? `Let the pane go, ${arrived} arrived while held`
                : 'Let the pane go'
              : 'Hold the pane'
          }
          title={held ? `${arrived} arrived while held` : 'Hold the pane still'}
          onClick={() => setHeld(held ? null : live)}
        >
          {held ? (arrived > 0 ? `held · ${arrived}` : 'held') : 'hold'}
        </button>
      </div>
    </>
  );
}

/**
 * The pane answers one question — what has arrived on this topic — so only arrivals belong in it.
 *
 * A command entry's `topic` is what the command was aimed at: a filter, possibly a wildcard, or
 * a count like '3 filters'. Matching that against the selection reads as traffic that never
 * happened — 'Subscribed to sensors/#' would sit under a selected sensors/# looking like an
 * arrival on a topic no broker ever published to.
 */
function carriesTraffic(entry: LogEntry, filter: string): boolean {
  return entry.kind === 'recv' && !!entry.topic && matchesFilter(filter, entry.topic);
}

/** A rule colours the topic a message landed on; a command entry never reaches the rows. */
function ruleForEntry(entry: LogEntry, ruleOf: (topic: string) => ColourRule | null) {
  return entry.topic ? ruleOf(entry.topic) : null;
}
