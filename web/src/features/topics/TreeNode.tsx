import { memo, type CSSProperties } from 'react';
import { nodeSummary, type TopicNode } from '../../lib/topicTree';
import { isPathOpen, useTopicTreeStore } from '../../stores/topicTreeStore';
import styles from './TopicTree.module.css';

type Props = { node: TopicNode; path: string; depth: number };

// Memoised on the node object: an unchanged branch keeps its identity through an update,
// so only the rows on the message's path re-render.
export const TreeNode = memo(function TreeNode({ node, path, depth }: Props) {
  const open = useTopicTreeStore((state) => isPathOpen(state, path));
  const toggle = useTopicTreeStore((state) => state.toggle);

  const isBranch = node.children.size > 0;

  // A row inside a closed branch is invisible, so the closed branch flashes on its behalf.
  // An open branch stays quiet; the visible descendant that was hit flashes instead.
  const flashAt = open && isBranch ? 0 : node.lastSubHitAt;

  return (
    <div className={styles.branch} data-open={open}>
      <div
        // Remounting on a new stamp restarts the CSS animation, which is what the old
        // console achieved by forcing a reflow.
        key={flashAt}
        className={styles.node}
        data-branch={isBranch}
        style={{ '--depth': depth } as CSSProperties}
        onClick={() => isBranch && toggle(path)}
      >
        <span className={styles.twisty}>▾</span>
        <span className={styles.seg}>{node.name}</span>
        <span className={styles.val}>{node.latestPayload ?? ''}</span>
        <span className={styles.meta}>{nodeSummary(node)}</span>
      </div>

      {/* A closed branch renders nothing beneath it. The old console hid its children with
          CSS, but a broker with thousands of topics only pays for what is on screen. */}
      {isBranch && open && (
        <div className={styles.kids}>
          {[...node.children.values()].map((child) => (
            <TreeNode key={child.name} node={child} path={`${path}/${child.name}`} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
});
