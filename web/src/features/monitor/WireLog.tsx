import { useEffect, useState } from 'react';
import type { ColourRule } from '../../lib/topicColour';
import { useRuleLookup } from '../../lib/useRuleLookup';
import { MIN_TOPIC_ENTRIES, type LogEntry } from '../../stores/logStore';
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
  const { selected, entries, fault } = useTraffic();

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

      {selected && entries.length === 0 && (
        /* A silent topic and a refused subscription look identical from here, and only one of
           them is the broker's doing. When the console has recorded a command that failed on
           this selection and has not since succeeded, that is the answer to why nothing is
           arriving — so it is what the pane says, instead of calling the topic quiet. */
        fault ? (
          <p className="empty" data-testid="stalled">
            <b className={styles.faultVerb}>{fault.verb ?? 'Failed'}</b>
            {fault.topic && <span className={styles.faultAt}> on {fault.topic}</span>}
            {fault.body && <span className={styles.faultWhy}>{fault.body}</span>}
          </p>
        ) : (
          <p className="empty">No traffic on {selected.label} yet.</p>
        )
      )}

      {/* Keying on the filter remounts the list on focus change, folding it back to the newest. */}
      {selected && entries.length > 0 && <EntryList key={selected.filter} />}
    </>
  );
}

function EntryList() {
  // How many rows are drawn. It used to be a boolean, and 'true' meant every entry the log holds
  // for the selection — up to five thousand of them, mounted at once into a region measured for
  // one row, on the broker selection people leave up while watching a whole broker. A step at a
  // time instead, starting at the run this codebase already calls readable.
  const [count, setCount] = useState(1);
  const { selected, live, entries, held, arrived, single } = useTraffic();
  const hold = useHoldStore((state) => state.hold);
  const release = useHoldStore((state) => state.release);
  const ruleOf = useRuleLookup();
  // What the pane says out loud when a row is put in the publish form. The form is a region of
  // its own and can be folded away entirely, so without this the action can have no observable
  // result at all.
  const [loaded, setLoaded] = useState('');

  // A hold outlives the pane that controls it: fold the Log region and the workspace unmounts
  // this, taking the only control that releases it, while the chart below goes on drawing a run
  // frozen at whatever moment the fold happened.
  useEffect(() => release, [release]);

  const shown = entries.slice(0, count);
  const all = count >= entries.length;

  // What the log still holds on this topic, which is what says whether there is history to open
  // and how far back it goes. Not the whole log: the pane only ever answers for the selection.
  const history = `${entries.length} in history`;
  const more = Math.min(MIN_TOPIC_ENTRIES, entries.length - count);

  return (
    <>
      <div className={styles.log}>
        {shown.map((entry, index) => (
          <LogEntryRow
            key={entry.id}
            entry={entry}
            rule={ruleForEntry(entry, ruleOf)}
            // Only where the pane itself already names the topic — one concrete topic, every row
            // the same. Under a wildcard the topic is what tells the rows apart, and a reader
            // scrolled into the middle of a run would be looking at rows naming nothing.
            repeats={single && index > 0}
            onLoaded={setLoaded}
          />
        ))}
      </div>

      {/* The action's only observable result when the publish form is folded away. */}
      <span className="srOnly" role="status" data-testid="loaded">
        {loaded && `${loaded} loaded into publish`}
      </span>

      <div className={styles.foot}>
        {/* A lone entry is already all of them, so the count states itself rather than offering
            to open onto nothing. */}
        {entries.length > 1 ? (
          <button
            type="button"
            className={styles.history}
            aria-expanded={count > 1}
            // The first click opens the run rather than adding to the one row already on show,
            // so the step is the same size whichever click it is.
            onClick={() =>
              setCount(all ? 1 : count === 1 ? MIN_TOPIC_ENTRIES : count + MIN_TOPIC_ENTRIES)
            }
          >
            {/* Unopened it says how much there is; opened it says how much more it will draw;
                exhausted it offers the way back. */}
            {all ? 'Show fewer' : count === 1 ? history : `${more} more`}
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
