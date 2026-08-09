import { memo, type CSSProperties } from 'react';
import { nodeSummary, type TopicNode } from '../../lib/topicTree';
import styles from './TopicTree.module.css';

type Props = {
  node: TopicNode;
  path: string;
  /** Shown instead of the node's own segment. The broker row is not a topic and has no segment. */
  label?: string;
  depth: number;
  isBranch: boolean;
  open: boolean;
  active: boolean;
  selected: boolean;
  onToggle: (path: string) => void;
  onSelect: (path: string, node: TopicNode) => void;
};

// Purely presentational: everything it needs arrives as a prop. Rows used to subscribe to the
// stores themselves, which made every message wake every row on a broker with thousands of them.
export const TreeNode = memo(function TreeNode({
  node,
  path,
  label,
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
      data-testid="tree-row"
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
          aria-label={`${open ? 'Collapse' : 'Expand'} ${label ?? path}`}
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
        // The twisty is a small target at the far left, so a double click anywhere on the row
        // is the same instruction, given to the part of it that is easy to hit.
        //
        // The clicks are counted here rather than read off a dblclick handler. A browser holds
        // the count while the pointer stays put, so a second double click in the same spot is
        // clicks three and four — and it does not have to call that a double click. Listening
        // for the event meant the branch opened once and then would not close.
        onClick={(event) => {
          // Enter on a focused row arrives with no count. That is a pick, and zero is even.
          if (event.detail <= 1) {
            onSelect(path, node);
            return;
          }

          if (event.detail % 2 !== 0 || !isBranch) return;

          // The run leaves the segment highlighted behind the row otherwise.
          window.getSelection()?.removeAllRanges();
          onToggle(path);
        }}
      >
        <span className={styles.seg}>{label ?? node.name}</span>
        <span className={styles.val}>{node.latestPayload ?? ''}</span>
        <span className={styles.meta}>{nodeSummary(node)}</span>
      </button>
    </div>
  );
});
