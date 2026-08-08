import { useCallback, useEffect, useMemo, useReducer } from 'react';
import { treeFilter } from '../../lib/topicMatch';
import { flattenTree, MAX_TREE_ROWS, type TopicRow } from '../../lib/topicTree';
import { useSelectionStore } from '../../stores/selectionStore';
import { isPathOpen, useTopicTreeStore } from '../../stores/topicTreeStore';
import styles from './TopicTree.module.css';
import { TreeNode } from './TreeNode';

// How long a row stays tinted after its last message. A row under steady traffic simply never
// stops being active, so it holds one colour instead of restarting a fade per message.
export const ACTIVE_WINDOW_MS = 1200;

export function TopicTree() {
  const root = useTopicTreeStore((state) => state.root);
  const openPaths = useTopicTreeStore((state) => state.openPaths);
  const defaultOpen = useTopicTreeStore((state) => state.defaultOpen);
  const toggle = useTopicTreeStore((state) => state.toggle);
  const setAllOpen = useTopicTreeStore((state) => state.setAllOpen);

  const selectedFilter = useSelectionStore((state) => state.selected?.filter ?? null);
  const select = useSelectionStore((state) => state.select);

  // The store is read once here rather than once per row, so a message wakes this component
  // alone and only the rows whose node object actually changed re-render.
  const { rows, hidden } = useMemo(
    () => flattenTree(root, (path) => isPathOpen({ openPaths, defaultOpen }, path), MAX_TREE_ROWS),
    [root, openPaths, defaultOpen],
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

  const onSelect = useCallback(
    (path: string) => select({ label: path, filter: treeFilter(path) }),
    [select],
  );

  return (
    <>
      <div className={styles.paneHead}>
        <h2 className={styles.eyebrow}>Topic tree</h2>
        <div className={styles.paneActions}>
          <button type="button" onClick={() => setAllOpen(true)} aria-label="Expand all" title="Expand all">
            ⤢
          </button>
          <button
            type="button"
            onClick={() => setAllOpen(false)}
            aria-label="Collapse all"
            title="Collapse all"
          >
            ⤡
          </button>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="empty">No topics yet. Connect to a broker and its tree builds here.</p>
      ) : (
        <div className={styles.tree}>
          {rows.map((row) => (
            <TreeNode
              key={row.path}
              node={row.node}
              path={row.path}
              depth={row.depth}
              isBranch={row.isBranch}
              open={row.open}
              active={lastHitOf(row) > activeSince}
              selected={row.path === selectedPath}
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
