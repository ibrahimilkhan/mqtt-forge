import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { SearchBox, SearchOpener } from '../../components/SearchBox';
import { WhereMenu } from '../../components/WhereMenu';
import { Fold, Unfold } from '../brand/icons';
import { useRuleLookup } from '../../lib/useRuleLookup';
import { matchesFilter, treeFilter } from '../../lib/topicMatch';
import {
  filterPath,
  flattenTree,
  MAX_TREE_ROWS,
  nodeAt,
  searchRows,
  type TopicNode,
  type TopicRow,
} from '../../lib/topicTree';
import { HoldButton } from '../monitor/HoldButton';
import { useHoldStore } from '../monitor/useTraffic';
import { useComposeStore } from '../../stores/composeStore';
import { useSearchStore } from '../../stores/searchStore';
import { useSelectionStore } from '../../stores/selectionStore';
import { useLogStore } from '../../stores/logStore';
import { isPathOpen, useTopicTreeStore } from '../../stores/topicTreeStore';
import styles from './TopicTree.module.css';
import { TreeNode } from './TreeNode';

// How long a row stays tinted after its last message. A row under steady traffic simply never
// stops being active, so it holds one colour instead of restarting a fade per message.
export const ACTIVE_WINDOW_MS = 1200;

// Reserved: a topic path can never contain a NUL, so the broker row cannot collide with one.
const BROKER_PATH = '\u0000broker';

// Everything the broker has sent, which is what picking its row focuses the wire log on.
const EVERYTHING = '#';

export function TopicTree({ broker }: { broker?: string }) {
  const root = useTopicTreeStore((state) => state.root);
  const openPaths = useTopicTreeStore((state) => state.openPaths);
  const defaultOpen = useTopicTreeStore((state) => state.defaultOpen);
  const toggle = useTopicTreeStore((state) => state.toggle);
  const toggleBroker = useTopicTreeStore((state) => state.toggleBroker);
  const setAllOpen = useTopicTreeStore((state) => state.setAllOpen);

  const selectedFilter = useSelectionStore((state) => state.selected?.filter ?? null);
  const select = useSelectionStore((state) => state.select);
  const load = useComposeStore((state) => state.load);

  const brokerOpen = useTopicTreeStore((state) => state.brokerOpen);

  // Rebuilt only when the rules change, so the answers it works out survive the renders that
  // messages cause — and a row asks about its own path, which never changes.
  const ruleOf = useRuleLookup();

  // The store is read once here rather than once per row, so a message wakes this component
  // alone and only the rows whose node object actually changed re-render.
  const forgotten = useTopicTreeStore((state) => state.forgotten);

  const { look, where } = useSearchStore((state) => state.tree);
  const setTree = useSearchStore((state) => state.setTree);
  const sought = look !== '';
  /** Whether the box is on screen. The mark on the broker's row is what opens it. */
  const [open, setOpen] = useState(false);

  /*
   * The rows: the open part of the tree, or — with something in the search box — every topic
   * that answers it, flat.
   *
   * A search is not a fold. Narrowing the tree in place would leave the reader opening three
   * branches to reach each match, which is the work the box exists to save, so under a search
   * every match stands at the top level under its whole path and the tree comes back the moment
   * the box is emptied. It also means the broker's own row keeps its meaning: what hangs off it
   * is the tree, and what replaces it is a list of answers.
   */
  const { rows, hidden } = useMemo(() => {
    if (!brokerOpen) return { rows: [] as TopicRow[], hidden: 0 };
    if (sought) return searchRows(root, look, where, MAX_TREE_ROWS);

    return flattenTree(root, (path) => isPathOpen({ openPaths, defaultOpen }, path), MAX_TREE_ROWS);
  }, [root, openPaths, defaultOpen, brokerOpen, sought, look, where]);

  // treeFilter only ever appends '/#', so peeling it off compares paths without allocating per row.
  const selectedPath = selectedFilter?.endsWith('/#') ? selectedFilter.slice(0, -2) : null;

  // Messages re-render this component anyway; silence does not, so the last tint needs one
  // more render to clear it. root.lastSubHitAt is the newest message anywhere in the tree.
  const [, retint] = useReducer((count: number) => count + 1, 0);
  const newestHitAt = root.lastSubHitAt;

  useEffect(() => {
    if (newestHitAt === 0) return;

    const remaining = ACTIVE_WINDOW_MS - (Date.now() - newestHitAt);
    if (remaining <= 0) return;

    const timer = setTimeout(retint, remaining);
    return () => clearTimeout(timer);
  }, [newestHitAt]);

  const activeSince = Date.now() - ACTIVE_WINDOW_MS;

  /*
   * The rows a hold is keeping still.
   *
   * The hold froze them when it was taken: a row draws its own node's fields, and every message
   * gives the nodes on its path fresh objects, so a node captured then goes on saying what it
   * said. Drawing the live one instead is what made the pause look broken — the reader pressed
   * it on a row and watched that row's own count go on climbing.
   *
   * A row the hold covers but the map does not know is a topic that arrived behind the hold. It
   * is not drawn at all: the rows stop where they are, and one appearing is not standing still.
   */
  const holding = useHoldStore((state) => state.held);

  /*
   * Every hold, with the test that says which rows it covers.
   *
   * There can be several now — a reader pausing one topic, going to read another and pausing
   * that too — and each of them freezes its own branch. A row is covered by the first hold that
   * claims it; a row under two nested holds is drawn from the inner one, which is the one the
   * reader took while looking at it.
   *
   * A path is a prefix test, and no walk of the filter per row. Anything else — a '+' in the
   * middle, a filter from somewhere other than a row — falls back to the matcher.
   */
  const holds = useMemo(
    () =>
      [...holding.values()]
        .map((one) => {
          const at = filterPath(one.filter);

          return {
            held: one,
            path: at,
            covers:
              one.filter === EVERYTHING
                ? () => true
                : at === null
                  ? (path: string) => matchesFilter(one.filter, path)
                  : (path: string) => path === at || path.startsWith(`${at}/`),
          };
        })
        // Deepest first, so a row under nested holds is drawn from the nearer of the two.
        .sort((a, b) => (b.path?.length ?? 0) - (a.path?.length ?? 0)),
    [holding],
  );

  const covering = useCallback(
    (path: string) => holds.find((one) => one.covers(path)) ?? null,
    [holds],
  );

  /** The rows a hold hangs off, for the mark each of them wears. */
  const heldPaths = useMemo(
    () => new Set(holds.map((one) => one.path).filter((path): path is string => path !== null)),
    [holds],
  );

  /*
   * What the hold is keeping out of the counts on the rows above it.
   *
   * A branch's summary is a count of everything under it, so an ancestor of a held row went on
   * counting messages the reader had just asked it to stop showing: the tree said five hundred
   * where the rows under it added up to three. The traffic behind the hold is exactly the held
   * branch's own growth since it was taken, and every ancestor's total contains all of it, so
   * one subtraction answers for all of them.
   *
   * Clamped at nothing: an unsubscribe can prune topics out from under a hold, and a count that
   * went up because rows went away would be a worse lie than the one this fixes.
   */
  const behind = useMemo(
    () =>
      holds.flatMap((one) => {
        if (one.path === null) return [];

        const live = nodeAt(root, one.path);
        const frozen = one.held.nodes.get(one.path);
        if (!live || !frozen) return [];

        return [
          {
            path: one.path,
            messages: Math.max(0, live.subMessages - frozen.subMessages),
            topics: Math.max(0, live.subTopics - frozen.subTopics),
          },
        ];
      }),
    [holds, root],
  );

  // Above the held rows, and only there: a sibling branch counts nothing that is being held. With
  // several holds an ancestor is over however many of them hang beneath it, so what it discounts
  // is their sum — and a hold nested inside another is counted once, by both, which is right:
  // each of them really is holding that traffic back from the row above.
  const above = useCallback(
    (path: string, node: TopicNode) => {
      const under = behind.filter((one) => one.path.startsWith(`${path}/`));
      if (under.length === 0) return node;

      return discount(node, {
        messages: under.reduce((sum, one) => sum + one.messages, 0),
        topics: under.reduce((sum, one) => sum + one.topics, 0),
      });
    },
    [behind],
  );

  /** The same sum for the broker's own row, which stands above every hold there is. */
  const allBehind = useMemo(
    () =>
      behind.length === 0
        ? null
        : {
            messages: behind.reduce((sum, one) => sum + one.messages, 0),
            topics: behind.reduce((sum, one) => sum + one.topics, 0),
          },
    [behind],
  );

  // One click does two things: focuses the wire log on the subtree, and loads the topic into
  // the publish form so it can be sent straight back with the settings it arrived under.
  const onSelect = useCallback(
    (path: string, node: TopicNode) => {
      // A leaf is one topic and a colour rule for it should say so; a branch stands for
      // everything under it, which is what clicking a branch means.
      const topic = node.children.size > 0 ? treeFilter(path) : path;

      select({ label: path, filter: treeFilter(path), topic });
      // A node that holds a message of its own hands over the whole of it — the body, and the QoS
      // and retain flag it was sent with — so that publishing it again publishes the same message.
      // A node that holds none hands over its path and nothing else: its flags are the placeholders
      // `leaf()` starts every node with, and writing those in would put a reader's ticked QoS 2
      // back to nought on the way past, which is exactly what it used to do.
      const held = node.latestMode !== null;

      // The whole body, when the tree is holding only the front of it. The tree cuts a message at
      // MAX_TREE_PAYLOAD because it keeps one per topic and there are fifty thousand of those;
      // the log keeps the run for this topic whole, so that is where the exact bytes are. Failing
      // that — a topic whose run the log has already given up — nothing is offered rather than a
      // body that would publish as a message the reader never sent.
      const body = node.latestTruncated
        ? useLogStore.getState().byTopic.get(path)?.newestFirst()[0]?.body
        : node.latestPayload ?? undefined;

      load({
        topic: path,
        payload: body,
        mode: node.latestMode ?? undefined,
        qos: held ? node.latestQos : undefined,
        retain: held ? node.latestRetain : undefined,
      });
    },
    [select, load],
  );

  // The broker is not a topic: it focuses the log on everything and has nothing to publish to.
  const brokerLabel = broker ?? 'Not connected';
  const pickBroker = useCallback(
    () => select({ label: brokerLabel, filter: EVERYTHING }),
    [select, brokerLabel],
  );

  /*
   * Glyphs, with the words kept as the accessible name and the tooltip. Three rules for the
   * fuller tree, two for the folded one — and not the ☰ that would say it best, since that is
   * already the panel menu in the bar above and would read as a second one.
   *
   * They ride on the broker's row, at its right end. What they open and close is the tree that
   * hangs off that row, and a strip of its own above the pane put a line and a band of empty
   * space between the pane's edge and the first topic to say so.
   */
  /*
   * The narrow pause, on the row it acts on.
   *
   * One row carries it — the selected one — because what it holds is the run the selection put
   * on screen, and a control on a row that is not selected would offer to hold something the
   * reader is not looking at. Made once and handed to that row alone: every other row is handed
   * nothing, so nothing about them changes and the memo around each of them still holds.
   */
  const hold = useMemo(() => <HoldButton />, []);

  /**
   * The pause on a row that is not the selected one.
   *
   * Made per path and kept, so a row that is paused is handed the same element on every render
   * and its memo still holds. There are as many of these as there are holds, which is a handful.
   */
  const holdsOn = useCallback((path: string) => <HoldButton over={treeFilter(path)} />, []);

  /**
   * Expand and collapse, over whatever the reader is actually looking at.
   *
   * With a branch picked, these two mean that branch. On a broker carrying thousands of topics
   * the whole-tree answer buries the thing they were looking at in everything they were not —
   * and the pair sits on the picked row itself, which is where a reader reads them as being about
   * it. With nothing picked there is nothing to scope to, and they mean the tree.
   *
   * The same two marks the message window puts over a folded document, because it is the same
   * gesture on the same kind of thing: everything out, everything in. They were `≡` and `=`,
   * which are two typographic characters that differ by one stroke and mean neither of those
   * things — a reader had to learn them here and could not carry what they learnt anywhere. The
   * chevron pair is one idea drawn once, and this console now draws it in both places it happens.
   */
  const treeActions = useMemo(() => {
    const of = selectedPath ? ` ${selectedPath}` : ' all';

    return (
      <div className={styles.rowActions}>
        <button
          type="button"
          onClick={() => setAllOpen(true, selectedPath)}
          aria-label={`Expand${of}`}
          title={selectedPath ? `Expand every branch under ${selectedPath}` : 'Expand every branch'}
        >
          <Unfold />
        </button>
        <button
          type="button"
          onClick={() => setAllOpen(false, selectedPath)}
          aria-label={`Collapse${of}`}
          title={
            selectedPath ? `Collapse every branch under ${selectedPath}` : 'Collapse every branch'
          }
        >
          <Fold />
        </button>
      </div>
    );
  }, [setAllOpen, selectedPath]);

  // The broker's row keeps the two tree marks at its end whether it is picked or not, and takes
  // the pause in front of them when it is: picking it focuses the log on everything, which is a
  // run like any other and can be held like one.
  /**
   * The search, on the row the whole tree hangs off.
   *
   * Here rather than in a strip of its own above the tree, because this is the row that stands
   * for the broker and the search is a question about everything under it — and because a strip
   * would cost the pane a line of height on every console, including the ones nobody will ever
   * search. The box opens to the left of the marks and ends where they begin.
   */
  const finding = (
    <>
      {open && (
        <SearchBox
          label="Search the topics"
          value={look}
          onChange={(next) => setTree({ look: next })}
          focused
        />
      )}
      <SearchOpener
        label="Find a topic"
        open={open}
        onToggle={() => {
          // Closing lets the search go: a box that hid itself while still narrowing the tree
          // would leave rows held back with nothing on screen to say why.
          if (open) setTree({ look: '' });
          setOpen((shown) => !shown);
        }}
      />
      {open && (
        <WhereMenu
          label="Where to look in the topics"
          value={where}
          onChange={(next) => setTree({ where: next })}
        />
      )}
    </>
  );

  const brokerActions = useMemo(
    () =>
      selectedFilter === EVERYTHING ? (
        <>
          {hold}
          {finding}
          {treeActions}
        </>
      ) : (
        <>
          {finding}
          {treeActions}
        </>
      ),
    [selectedFilter, hold, finding, treeActions],
  );

  return (
    <>
      <h2 className="srOnly">Topics</h2>

      {root.subTopics === 0 ? (
        <p className="empty">No topics yet. Connect to a broker and its tree builds here.</p>
      ) : (
        <div className={styles.tree} data-finding={open ? '' : undefined}>
          {/* One root for the whole broker, so the totals are readable without expanding
              anything — and so collapsing it puts the entire tree away in one click. It stands
              over a search's answers too: it is still the broker they came from, it is still
              how a reader gets back to everything, and its counts are still the tree's. */}
          <TreeNode
            // The broker's row is above every topic there is, so it too counts what is held.
            node={allBehind ? discount(root, allBehind) : root}
            path={BROKER_PATH}
            label={brokerLabel}
            depth={0}
            isBranch
            open={brokerOpen}
            active={false}
            selected={selectedFilter === EVERYTHING}
            actions={brokerActions}
            onToggle={toggleBroker}
            onSelect={pickBroker}
          />

          {/* A search that matched nothing says so under the broker's row rather than in place of
              the tree. In place of it, the row went too — and the row is where the search box and
              the mark that shuts it live, so a reader who mistyped was left looking at a sentence
              with no way back to the tree it was about. */}
          {sought && rows.length === 0 && (
            <p className="empty" data-testid="no-topic-found">
              No topic{' '}
              {where === 'body' ? 'is carrying' : where === 'topic' ? 'is named for' : 'says'} “
              {look}”.
            </p>
          )}

          {rows.map((row) => {
            const over = covering(row.path);
            const frozen = over ? (over.held.nodes.get(row.path) ?? null) : null;
            // Covered, and not in the hold: it arrived behind the hold and is not drawn.
            if (frozen === null && over) return null;

            const node = frozen ?? above(row.path, row.node);

            return (
              <TreeNode
                key={row.path}
                node={node}
                path={row.path}
                // Under a search a row stands for itself rather than for a place in a tree, so
                // it is drawn at one depth and named by its whole path — a bare last segment in
                // a flat list of matches names nothing a reader can act on.
                label={sought ? row.path : undefined}
                depth={sought ? 1 : row.depth + 1}
                isBranch={sought ? false : row.isBranch}
                open={row.open}
                active={lastHitOf(row, node) > activeSince}
                selected={row.path === selectedPath}
                // The selected row carries the pause; so does any row that is paused, wherever
                // the reader has gone since. A hold nobody can see is a hold nobody can undo.
                actions={
                  row.path === selectedPath
                    ? hold
                    : heldPaths.has(row.path)
                      ? holdsOn(row.path)
                      : undefined
                }
                rule={ruleOf(row.path)}
                onToggle={toggle}
                onSelect={onSelect}
              />
            );
          })}
        </div>
      )}

      {(hidden > 0 || forgotten > 0) && (
        <p className={styles.capped}>
          {hidden > 0 &&
            `${hidden.toLocaleString('en-GB')} more ${hidden === 1 ? 'topic' : 'topics'} ${sought ? 'matched' : 'not shown'}`}
          {hidden > 0 && forgotten > 0 && ' · '}
          {/* Not the same thing as the line before it, and the difference is the whole reason it
              is said: those are on screen's other side, these are gone. A tree that forgets is
              allowed to — a broker whose topic names carry an id would otherwise fill a laptop —
              but a tree that forgets in silence leaves a reader with an emptiness they cannot
              read. See MAX_TREE_TOPICS. */}
          {forgotten > 0 &&
            `${forgotten.toLocaleString('en-GB')} quiet ${forgotten === 1 ? 'topic' : 'topics'} forgotten`}
        </p>
      )}
    </>
  );
}

/**
 * The same row with the held branch's traffic taken out of its totals.
 *
 * A fresh object, which the memoised row will see as a change — but only the handful of rows
 * directly above a held one are given one, and a hold is a deliberate, temporary state.
 */
function discount(node: TopicNode, behind: { messages: number; topics: number }): TopicNode {
  return {
    ...node,
    subTopics: node.subTopics - behind.topics,
    subMessages: node.subMessages - behind.messages,
  };
}

// A closed branch reports the traffic of its (undrawn) rows; an open one only its own, since
// its children are on screen to speak for themselves. The node is passed rather than read off
// the row: a held row is drawn from the node the hold froze, and its tint has to freeze with it.
const lastHitOf = (row: TopicRow, node: TopicNode) =>
  row.open && row.isBranch ? node.lastHitAt : node.lastSubHitAt;
