import { memo, type CSSProperties } from 'react';
import { treeFilter } from '../../lib/topicMatch';
import { nodeSummary, type TopicNode } from '../../lib/topicTree';
import { useSelectionStore } from '../../stores/selectionStore';
import { isPathOpen, useTopicTreeStore } from '../../stores/topicTreeStore';
import styles from './TopicTree.module.css';

type Props = { node: TopicNode; path: string; depth: number };

// Memoised on the node object, so only rows on the message's path re-render.
export const TreeNode = memo(function TreeNode({ node, path, depth }: Props) {
  const open = useTopicTreeStore((state) => isPathOpen(state, path));
  const toggle = useTopicTreeStore((state) => state.toggle);
  const filter = treeFilter(path);
  const selected = useSelectionStore((state) => state.selected?.filter === filter);
  const select = useSelectionStore((state) => state.select);

  const isBranch = node.children.size > 0;

  // Closed branch flashes on behalf of its (invisible) rows; open branch only for itself.
  const flashAt = open && isBranch ? node.lastHitAt : node.lastSubHitAt;

  return (
    <div className={styles.branch} data-open={open}>
      <div
        // Remounting on a new stamp restarts the flash animation.
        key={flashAt}
        className={styles.node}
        data-branch={isBranch}
        data-selected={selected}
        style={{ '--depth': depth } as CSSProperties}
      >
        {/* Sibling buttons: twisty toggles the branch, the rest selects it for the wire log. */}
        {isBranch ? (
          <button
            type="button"
            className={styles.twisty}
            onClick={() => toggle(path)}
            aria-label={`${open ? 'Collapse' : 'Expand'} ${path}`}
          >
            ▾
          </button>
        ) : (
          <span className={styles.twisty} aria-hidden="true">
            ▾
          </span>
        )}

        <button
          type="button"
          className={styles.pick}
          aria-pressed={selected}
          onClick={() => select({ label: path, filter })}
        >
          <span className={styles.seg}>{node.name}</span>
          <span className={styles.val}>{node.latestPayload ?? ''}</span>
          <span className={styles.meta}>{nodeSummary(node)}</span>
        </button>
      </div>

      {/* Kept mounted, hidden by CSS — unmounting would remount on expand and flash the whole subtree. */}
      {isBranch && (
        <div className={styles.kids}>
          {[...node.children.values()].map((child) => (
            <TreeNode key={child.name} node={child} path={`${path}/${child.name}`} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
});
