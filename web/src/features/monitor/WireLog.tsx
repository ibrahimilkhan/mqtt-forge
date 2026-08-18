import { useState } from 'react';
import type { ColourRule } from '../../lib/topicColour';
import { useRuleLookup } from '../../lib/useRuleLookup';
import type { LogEntry } from '../../stores/logStore';
import { LogEntryRow } from './LogEntryRow';
import { useHoldStore, useTraffic } from './useTraffic';
import styles from './WireLog.module.css';

/**
 * The top of the right column: what arrived last, and the rest of it on request.
 *
 * The chart that reads this run sits under it in its own region, and the publish form under
 * that. Three fixed places, so the newest reading is always at the top of the column whatever
 * the run behind it is doing.
 */
export function WireLog() {
  const { selected, entries } = useTraffic();

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

      {selected && entries.length === 0 && <p className="empty">No traffic on {selected.label} yet.</p>}

      {/* Keying on the filter remounts the list on focus change, folding it back to the newest. */}
      {selected && entries.length > 0 && <EntryList key={selected.filter} />}
    </>
  );
}

function EntryList() {
  const [expanded, setExpanded] = useState(false);
  const { selected, live, entries, held, arrived } = useTraffic();
  const hold = useHoldStore((state) => state.hold);
  const release = useHoldStore((state) => state.release);
  const ruleOf = useRuleLookup();

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
          aria-pressed={held}
          aria-label={
            held
              ? arrived > 0
                ? `Let the pane go, ${arrived} arrived while held`
                : 'Let the pane go'
              : 'Hold the pane'
          }
          title={held ? `${arrived} arrived while held` : 'Hold the pane still'}
          onClick={() => (held ? release() : hold(selected!.filter, live))}
        >
          {held ? (arrived > 0 ? `held · ${arrived}` : 'held') : 'hold'}
        </button>
      </div>
    </>
  );
}

/** A rule colours the topic a message landed on; a command entry never reaches the rows. */
function ruleForEntry(entry: LogEntry, ruleOf: (topic: string) => ColourRule | null) {
  return entry.topic ? ruleOf(entry.topic) : null;
}
