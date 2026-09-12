import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { SearchBox, SearchOpener } from '../../components/SearchBox';
import { WhereMenu } from '../../components/WhereMenu';
import { useConnectionState } from '../../api/useConnectionState';
import type { ColourRule } from '../../lib/topicColour';
import { useRuleLookup } from '../../lib/useRuleLookup';
import { clearSelection } from '../../stores/clearTraffic';
import { MIN_TOPIC_ENTRIES, type LogEntry } from '../../stores/logStore';
import { useSearchStore } from '../../stores/searchStore';
import { LogEntryRow } from './LogEntryRow';
import { useShownEntries, useTraffic, useTrafficCount } from './useTraffic';
import styles from './WireLog.module.css';

/**
 * The room left under the last row a step lands on, in pixels.
 *
 * Landing a row exactly on the fold is right to the pixel and wrong to the eye: a value sitting
 * hard against the edge of its region reads as a value that has been cut, and the reader looks
 * for the rest of it. Three pixels is the channel the whole console is spaced by, and it is
 * enough to say the row ends where it ends.
 */
const TAIL = 3;

/**
 * The top of the right column: what arrived last, and the rest of it on request.
 *
 * The chart that reads this run sits under it in its own region, and the publish form under
 * that. Three fixed places, so the newest reading is always at the top of the column whatever
 * the run behind it is doing.
 */
export function WireLog() {
  const { selected, fault } = useTraffic();
  const { isOnline } = useConnectionState();
  const { entries, all, sought } = useShownEntries();
  // What was typed and where it was looked for, so the pane can quote it back when it finds
  // nothing — the same pair the box and the menu above the pane are driven by.
  const { look, where } = useSearchStore((state) => state.log);

  return (
    <>
      {/* The only heading the pane has, and it is off screen: the entries start at the pane's
          edge. Every row names its own topic, so a strip naming the selection above them was
          furniture over a list that already says what it is about. */}
      <h2 className="srOnly">Logs</h2>

      {!selected && (
        <p className="empty">
          Pick a topic to see its traffic.
        </p>
      )}

      {/* A search that matches nothing is not a quiet topic, and the sentence about a quiet
          topic under a box the reader has just typed into is the console answering the wrong
          question. */}
      {selected && all > 0 && entries.length === 0 && (
        <p className="empty" data-testid="unfound">
          {/* Named, like the three other panes that answer an empty search — the tree, the events
              card and the alerts picker all quote the term back. This one said 'what you are
              looking for', which is the console talking about the reader rather than about what
              it looked through, and leaves anyone who has typed twice unsure which of the two
              found nothing. The wording follows the menu beside the box. */}
          {where === 'body'
            ? `No message in this run carries \u201C${look}\u201D.`
            : where === 'topic'
              ? `No topic in this run is named for \u201C${look}\u201D.`
              : `Nothing in this run says \u201C${look}\u201D.`}
        </p>
      )}

      {selected && all === 0 && (
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
        ) : isOnline ? (
          <p className="empty">No traffic on {selected.label} yet.</p>
        ) : (
          /* A quiet topic and a console listening to nothing are not the same answer, and this
             pane used to give the first for both. The tree beside it already tells the two
             apart; a reader who had picked a topic off a tree left over from the last session
             was being told the broker had gone quiet. */
          <p className="empty">Connect a broker to see traffic on {selected.label}.</p>
        )
      )}

      {/* Keying on the filter remounts the list on focus change, folding it back to the newest.
          The search is part of the key for the same reason: a run narrowed to three rows should
          open at its newest rather than at wherever the unnarrowed run had been stepped to. */}
      {selected && entries.length > 0 && (
        <EntryList key={`${selected.filter}${sought ? '\u0000sought' : ''}`} />
      )}
    </>
  );
}

/**
 * What to look for, where to look for it, and the way to empty the lot.
 *
 * At the end of the region's own strip, beside the name and the count. It used to stand on a line
 * of its own above the rows, because the strip was one control from end to end — a search box
 * inside a button is a control a reader cannot use — and a line of chrome over every list of
 * messages is a line the messages do not get. The strip holds both now: see Region, where the
 * fold is a button that takes whatever the tools leave rather than the whole row.
 *
 * Nothing at all without a selection: no rows to search, and nothing this pane is answering for.
 */
export function LogTools() {
  const { selected } = useTraffic();
  const { look, where } = useSearchStore((state) => state.log);
  const setLog = useSearchStore((state) => state.setLog);
  const [open, setOpen] = useState(false);
  /* Not undoable, so one press asks and the next does it — and what it does is bounded by the
     selection this pane is showing. It used to empty the console: every topic, every branch, the
     whole tree, because a reader wanted one run out of the way. */
  const [asking, setAsking] = useState(false);
  const held = useTrafficCount();

  if (!selected) return null;

  return (
    <div className={styles.tools}>
      {/* The box grows into the room the marks leave, and only once it has been asked for. */}
      {open && (
        <SearchBox
          label="Search the log"
          value={look}
          onChange={(next) => setLog({ look: next })}
          focused
        />
      )}
      <SearchOpener
        label="Find in the log"
        open={open}
        onToggle={() => {
          // Closing lets the search go: a hidden box that went on narrowing the pane would be a
          // pane holding rows back with nothing on screen to say why.
          if (open) setLog({ look: '' });
          setOpen((shown) => !shown);
        }}
      />
      {open && (
        <WhereMenu
          label="Where to look in the log"
          value={where}
          onChange={(next) => setLog({ where: next })}
        />
      )}
      {asking ? (
        <>
          {/* All of it, and the topic goes from the tree with its run: a row whose messages are
              gone is the fault this console's shape exists to prevent. */}
          <button
            type="button"
            className={styles.tool}
            data-grave=""
            title={`Clear ${selected.label} and take it off the tree. Nothing here can put it back.`}
            onClick={() => {
              clearSelection(selected.filter, 'nothing');
              setAsking(false);
            }}
          >
            Clear {held.toLocaleString('en-GB')}
          </button>
          {/* Or the pane cleared with the reading left on it, which is the one every console
              wants half the time: the history goes and the current value stays. Only worth
              offering while there is history to lose. */}
          {held > 1 && (
            <button
              type="button"
              className={styles.tool}
              title="Clear the run and leave the newest message on it."
              onClick={() => {
                clearSelection(selected.filter, 'the newest');
                setAsking(false);
              }}
            >
              Keep newest
            </button>
          )}
          <button type="button" className={styles.tool} onClick={() => setAsking(false)}>
            Cancel
          </button>
        </>
      ) : (
        <button
          type="button"
          className={styles.tool}
          disabled={held === 0}
          title={`Clear the traffic on ${selected.label}`}
          onClick={() => setAsking(true)}
        >
          Clear
        </button>
      )}
    </div>
  );
}

/**
 * How much traffic the selection holds, beside the Log region's own name.
 *
 * Its own component because of where it goes: the strip belongs to the workspace, which knows
 * nothing about the log and should go on knowing nothing about it. This subscribes for itself, so
 * an arrival re-renders a number rather than the console around it — and it is the only thing the
 * strip says when the region is folded and the pane is gone.
 *
 * Nothing at all when there is nothing: an empty selection already says so in the pane, and a
 * '(0)' beside the name is a fact about a question nobody asked.
 */
export function LogCount() {
  const count = useTrafficCount();
  const { entries, sought } = useShownEntries();

  if (count === 0) return null;

  // Under a search it says both numbers, for the reason the broker events card does: a reader
  // who has narrowed a run wants to know how much of it they are being shown.
  return sought ? <>({entries.length} of {count})</> : <>({count})</>;
}

function EntryList() {
  // How many rows are drawn. It used to be a boolean, and 'true' meant every entry the log holds
  // for the selection — up to five thousand of them, mounted at once into a region measured for
  // one row, on the broker selection people leave up while watching a whole broker. A step at a
  // time instead, starting at the run this codebase already calls readable.
  const { single } = useTraffic();
  const { entries, sought } = useShownEntries();
  // One row is right for a pane nobody has asked anything of: the newest value, and the rest on
  // request. A reader who has typed into the search box has asked, and a single row under a
  // search that matched twelve is the console making them press for what they already asked for.
  // The remount on the search going on and off (see the key) is what makes this the start again.
  const [count, setCount] = useState(sought ? MIN_TOPIC_ENTRIES : 1);

  const ruleOf = useRuleLookup();
  // What the pane says out loud when a row is put in the publish form. The form is a region of
  // its own and can be folded away entirely, so without this the action can have no observable
  // result at all.
  const [loaded, setLoaded] = useState('');

  const shown = entries.slice(0, count);
  const all = count >= entries.length;

  const list = useRef<HTMLDivElement>(null);
  const { below, onward } = useBelowFold(list, count);

  // What the log is holding BACK on this topic — the run behind what is drawn, which is what says
  // whether there is any history to open and how far it goes. Not the whole run: the newest
  // message is on screen, and counting it made the line answer a question nobody asked. It also
  // made the one-message case say '1 in history' about the message being read.
  //
  // Not the whole log either: the pane only ever answers for the selection.
  const behind = entries.length - count;
  const history = `${behind} in history`;
  const more = Math.min(MIN_TOPIC_ENTRIES, behind);

  return (
    <>
      {/* `data-resting` is the log telling the workspace it is drawing the newest message and
          nothing else, which is the one fact only this component has. While it is there the
          column stays sized to its content, so the region is exactly as tall as the message —
          every message, not just the first one that ever landed here. The workspace reads it off
          the DOM rather than being handed it, the same way this pane finds its own scrollport by
          walking up and a seam finds its neighbours by asking for them. */}
      <div className={styles.log} ref={list} data-resting={count === 1 ? '' : undefined}>
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

      {/* A lone entry has nothing behind it, so there is no foot at all. It used to carry a line
          reading '1 in history' — a count of the one message the reader was looking at, under the
          message, in a pane whose whole job is to show it. Nothing to say is nothing to draw. */}
      {entries.length > 1 && (
        <div className={styles.foot}>
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
            {/* Unopened it says how much is held back; opened it says how much more it will draw;
                exhausted it offers the way back. */}
            {all ? 'Show fewer' : count === 1 ? history : `${more} more`}
          </button>
        </div>
      )}

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
 * The two shapes on the control that stops the pane.
 *
 * Drawn rather than typed: the characters for these are in the emoji block, and a font that has
 * them renders a pair of coloured lozenges in a row of 10px mono type. Twelve units square, in
 * the current text colour, so the control's own state colours them.
 */



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

  // A screen at a time — not to the end: the reader asked to see what is below, not to arrive at
  // the oldest entry the log is holding.
  //
  // And it stops on a row's edge rather than after a fixed distance. A screen of a list is only
  // rarely a whole number of rows, so a fixed step leaves the last one cut in half at the fold,
  // and the reader's eye has to decide whether the half-value it can see is worth scrolling for.
  // The step here is the furthest row that ends within a screen of where the fold is now, so the
  // screen it lands on finishes exactly where that row does — plus TAIL, so it finishes just
  // short of the edge rather than against it.
  const onward = () => {
    const pane = region.current;
    const list = listRef.current;
    if (!pane || !list) return;

    const fold = pane.getBoundingClientRect().bottom;
    let step = 0;
    for (const row of list.children) {
      const gap = row.getBoundingClientRect().bottom - fold;
      // In order, so the last one that still fits is the furthest one that does.
      if (gap > 0 && gap <= pane.clientHeight) step = gap;
    }

    // Nothing ends inside the next screen: one row is taller than the region, so take the screen.
    pane.scrollBy({ top: (step || pane.clientHeight) + TAIL, behavior: 'smooth' });
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
