import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
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

  const list = useRef<HTMLDivElement>(null);
  const { below, onward } = useBelowFold(list, count);

  // What the log still holds on this topic, which is what says whether there is history to open
  // and how far back it goes. Not the whole log: the pane only ever answers for the selection.
  const history = `${entries.length} in history`;
  const more = Math.min(MIN_TOPIC_ENTRIES, entries.length - count);

  return (
    <>
      <div className={styles.log} ref={list}>
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

      {/* Opened, the run is nearly always taller than the region it is drawn in, and the only
          thing saying so was a scrollbar — which on this platform is not drawn until the pointer
          is already moving. So the pane says it: how much is down there, pinned to the fold,
          pointing at it. The click is what a reader was going to do next anyway.

          Named 'more' like the control in the foot above, and they do mean the same word about
          two different things: that one draws rows the log is holding back, this one scrolls
          onto rows already drawn. The arrow is the difference, and it is the reason this one
          can be a glance rather than a read. */}
      {below > 0 && (
        <div className={styles.dock}>
          <button
            type="button"
            className={styles.below}
            aria-label={`${below} more below`}
            onClick={onward}
          >
            {below} more <span aria-hidden="true">↓</span>
          </button>
        </div>
      )}
    </>
  );
}

/**
 * How many rows are drawn below what the region can show, and the way onto them.
 *
 * The region is the scrolling one, not this pane: the log is given a height by the workspace and
 * scrolls inside it, so the fold is the region's bottom edge and the rows are measured against
 * it. Nothing is passed down to say which element that is — the pane has never had to know — so
 * it is found the way the browser finds it, by walking up to the first ancestor that scrolls.
 */
function useBelowFold(listRef: RefObject<HTMLDivElement | null>, drawn: number) {
  const [below, setBelow] = useState(0);
  const region = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const list = listRef.current;
    const pane = scrolling(list);
    region.current = pane;
    if (!list || !pane) return setBelow(0);

    const recount = () => {
      const fold = pane.getBoundingClientRect().bottom;
      // A layout nothing has measured puts every row at zero, which is not the same answer as
      // every row being out of sight.
      if (fold <= 0) return setBelow(0);

      const rows = [...list.children];
      setBelow(rows.length - firstBelow(rows, fold));
    };

    recount();
    pane.addEventListener('scroll', recount, { passive: true });
    // The seam that sizes the region, and the rows themselves: a payload opened out is as much a
    // change to what fits as a drag is.
    const watch = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(recount);
    watch?.observe(pane);
    watch?.observe(list);

    return () => {
      pane.removeEventListener('scroll', recount);
      watch?.disconnect();
    };
  }, [listRef, drawn]);

  // A screen at a time, with a row's worth of overlap so nothing passes by unread between one
  // click and the next. Not to the end: the reader asked to see what is below, not to arrive at
  // the oldest entry the log is holding.
  const onward = () => {
    const pane = region.current;
    pane?.scrollBy({ top: Math.max(pane.clientHeight - 44, 44), behavior: 'smooth' });
  };

  return { below, onward };
}

/**
 * The first row whose top edge has fallen past the fold.
 *
 * Binary search rather than a sweep: this answers on every scroll frame, and the rows are in
 * document order, so a run of two hundred costs eight measurements instead of two hundred.
 */
function firstBelow(rows: ReadonlyArray<Element>, fold: number) {
  let low = 0;
  let high = rows.length;

  while (low < high) {
    const mid = (low + high) >> 1;
    if (rows[mid].getBoundingClientRect().top >= fold) high = mid;
    else low = mid + 1;
  }

  return low;
}

/**
 * The nearest ancestor that actually scrolls — the region the workspace gave this pane.
 *
 * Stops at the body rather than walking into it: once the columns stack, the region is told to
 * overflow visibly and the page itself is what scrolls. Nothing is clipped then, so there is
 * nothing to report, and a walk that went as far as the document would have reported the whole
 * rest of the page as hidden below the fold.
 */
function scrolling(from: Element | null) {
  for (let node = from?.parentElement; node && node !== document.body; node = node.parentElement) {
    const flow = getComputedStyle(node).overflowY;
    if (flow === 'auto' || flow === 'scroll') return node;
  }

  return null;
}

/** A rule colours the topic a message landed on; a command entry never reaches the rows. */
function ruleForEntry(entry: LogEntry, ruleOf: (topic: string) => ColourRule | null) {
  return entry.topic ? ruleOf(entry.topic) : null;
}
