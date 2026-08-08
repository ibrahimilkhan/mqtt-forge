import { memo, type CSSProperties } from 'react';
import { nodeSummary, type TopicNode } from '../../lib/topicTree';
import styles from './TopicTree.module.css';

type Props = {
  node: TopicNode;
  path: string;
  depth: number;
  isBranch: boolean;
  open: boolean;
  active: boolean;
  selected: boolean;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
};

// Purely presentational: everything it needs arrives as a prop. Rows used to subscribe to the
// stores themselves, which made every message wake every row on a broker with thousands of them.
export const TreeNode = memo(function TreeNode({
  node,
  path,
  depth,
  isBranch,
  open,
  active,
  selected,
  onToggle,
  onSelect,
}: Props) {
  return (
    <div
      className={styles.node}
      data-open={open}
      data-branch={isBranch}
      data-active={active}
      data-selected={selected}
      data-depth={depth}
      style={{ '--depth': depth } as CSSProperties}
    >
      {/* Sibling buttons: twisty toggles the branch, the rest selects it for the wire log. */}
      {isBranch ? (
        <button
          type="button"
          className={styles.twisty}
          onClick={() => onToggle(path)}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${path}`}
        >
          ▾
        </button>
      ) : (
        <span className={styles.twisty} aria-hidden="true">
          ▾
        </span>
      )}

      <button type="button" className={styles.pick} aria-pressed={selected} onClick={() => onSelect(path)}>
        <span className={styles.seg}>{node.name}</span>
        <span className={styles.val}>{node.latestPayload ?? ''}</span>
        <span className={styles.meta}>{nodeSummary(node)}</span>
      </button>
    </div>
  );
});
