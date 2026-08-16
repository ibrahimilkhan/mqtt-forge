import { useCallback, useEffect, useMemo, useReducer } from 'react';
import { useRuleLookup } from '../../lib/useRuleLookup';
import { treeFilter } from '../../lib/topicMatch';
import { flattenTree, MAX_TREE_ROWS, type TopicNode, type TopicRow } from '../../lib/topicTree';
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

  return (
    <>
      <div className={styles.paneHead}>
        <h2 className={styles.eyebrow}>Topics</h2>
        {/* Glyphs, with the words kept as the accessible name and the tooltip. The box pair is
            deliberately not the row's own chevron: these act on the whole tree, and a control
            that looks like the one beside a branch reads as belonging to that branch. */}
        <div className={styles.paneActions}>
          <button
            type="button"
            onClick={() => setAllOpen(true)}
            aria-label="Expand all"
            title="Expand every branch"
          >
            ⊞
          </button>
          <button
            type="button"
            onClick={() => setAllOpen(false)}
            aria-label="Collapse all"
            title="Collapse every branch"
          >
            ⊟
          </button>
        </div>
      </div>

      {root.subTopics === 0 ? (
        <p className="empty">No topics yet. Connect to a broker and its tree builds here.</p>
      ) : (
        <div className={styles.tree}>
          {/* One root for the whole broker, so the totals are readable without expanding
              anything — and so collapsing it puts the entire tree away in one click. */}
          <TreeNode
            node={root}
            path={BROKER_PATH}
            label={brokerLabel}
            depth={0}
            isBranch
            open={brokerOpen}
            active={false}
            selected={selectedFilter === EVERYTHING}
            onToggle={toggleBroker}
            onSelect={pickBroker}
          />

          {rows.map((row) => (
            <TreeNode
              key={row.path}
              node={row.node}
              path={row.path}
              depth={row.depth + 1}
              isBranch={row.isBranch}
              open={row.open}
              active={lastHitOf(row) > activeSince}
              selected={row.path === selectedPath}
              rule={ruleOf(row.path)}
              onToggle={toggle}
              onSelect={onSelect}
            />
          ))}
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

// A closed branch reports the traffic of its (undrawn) rows; an open one only its own, since
// its children are on screen to speak for themselves.
const lastHitOf = (row: TopicRow) =>
  row.open && row.isBranch ? row.node.lastHitAt : row.node.lastSubHitAt;
