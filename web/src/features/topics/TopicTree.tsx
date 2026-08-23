import { useCallback, useEffect, useMemo, useReducer } from 'react';
import { useRuleLookup } from '../../lib/useRuleLookup';
import { filterPath, matchesFilter, treeFilter } from '../../lib/topicMatch';
import {
  flattenTree,
  MAX_TREE_ROWS,
  nodeAt,
  type TopicNode,
  type TopicRow,
} from '../../lib/topicTree';
import { HoldButton } from '../monitor/HoldButton';
import { useHoldStore } from '../monitor/useTraffic';
import { useComposeStore } from '../../stores/composeStore';
import { useSelectionStore } from '../../stores/selectionStore';
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
  const { rows, hidden } = useMemo(
    () =>
      brokerOpen
        ? flattenTree(root, (path) => isPathOpen({ openPaths, defaultOpen }, path), MAX_TREE_ROWS)
        : { rows: [], hidden: 0 },
    [root, openPaths, defaultOpen, brokerOpen],
  );

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
  // The row the hold hangs off, when it hangs off one. Every hold the tree can take does.
  const holdPath = holding ? filterPath(holding.filter) : null;

  const covers = useMemo(() => {
    if (!holding) return null;

    // A path is a prefix test, and no walk of the filter per row. Anything else — a '+' in the
    // middle, a filter from somewhere other than a row — falls back to the matcher.
    if (holding.filter === EVERYTHING) return () => true;
    if (holdPath === null) return (path: string) => matchesFilter(holding.filter, path);

    return (path: string) => path === holdPath || path.startsWith(`${holdPath}/`);
  }, [holding, holdPath]);

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
  const behind = useMemo(() => {
    if (!holding || holdPath === null) return null;

    const live = nodeAt(root, holdPath);
    const frozen = holding.nodes.get(holdPath);
    if (!live || !frozen) return null;

    return {
      path: holdPath,
      messages: Math.max(0, live.subMessages - frozen.subMessages),
      topics: Math.max(0, live.subTopics - frozen.subTopics),
    };
  }, [holding, holdPath, root]);

  // Above the held row, and only there: a sibling branch counts nothing that is being held.
  const above = useCallback(
    (path: string, node: TopicNode) =>
      behind && behind.path.startsWith(`${path}/`) ? discount(node, behind) : node,
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
      load({
        topic: path,
        payload: node.latestPayload ?? undefined,
        mode: node.latestMode ?? undefined,
        qos: node.latestQos,
        retain: node.latestRetain,
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

  const treeActions = useMemo(
    () => (
      <div className={styles.rowActions}>
        <button
          type="button"
          onClick={() => setAllOpen(true)}
          aria-label="Expand all"
          title="Expand every branch"
        >
          ≡
        </button>
        <button
          type="button"
          onClick={() => setAllOpen(false)}
          aria-label="Collapse all"
          title="Collapse every branch"
        >
          =
        </button>
      </div>
    ),
    [setAllOpen],
  );

  // The broker's row keeps the two tree glyphs at its end whether it is picked or not, and takes
  // the pause in front of them when it is: picking it focuses the log on everything, which is a
  // run like any other and can be held like one.
  const brokerActions = useMemo(
    () =>
      selectedFilter === EVERYTHING ? (
        <>
          {hold}
          {treeActions}
        </>
      ) : (
        treeActions
      ),
    [selectedFilter, hold, treeActions],
  );

  return (
    <>
      <h2 className="srOnly">Topics</h2>

      {root.subTopics === 0 ? (
        <p className="empty">No topics yet. Connect to a broker and its tree builds here.</p>
      ) : (
        <div className={styles.tree}>
          {/* One root for the whole broker, so the totals are readable without expanding
              anything — and so collapsing it puts the entire tree away in one click. */}
          <TreeNode
            // The broker's row is above every topic there is, so it too counts what is held.
            node={behind ? discount(root, behind) : root}
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

          {rows.map((row) => {
            const frozen = covers?.(row.path) ? (holding?.nodes.get(row.path) ?? null) : null;
            // Covered, and not in the hold: it arrived behind the hold and is not drawn.
            if (frozen === null && covers?.(row.path)) return null;

            const node = frozen ?? above(row.path, row.node);

            return (
              <TreeNode
                key={row.path}
                node={node}
                path={row.path}
                depth={row.depth + 1}
                isBranch={row.isBranch}
                open={row.open}
                active={lastHitOf(row, node) > activeSince}
                selected={row.path === selectedPath}
                actions={row.path === selectedPath ? hold : undefined}
                rule={ruleOf(row.path)}
                onToggle={toggle}
                onSelect={onSelect}
              />
            );
          })}
        </div>
      )}

      {hidden > 0 && (
        <p className={styles.capped}>
          {hidden} more {hidden === 1 ? 'topic' : 'topics'} not shown
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
