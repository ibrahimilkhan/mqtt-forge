import { useTopicTreeStore } from '../../stores/topicTreeStore';
import styles from './TopicTree.module.css';
import { TreeNode } from './TreeNode';

export function TopicTree() {
  const root = useTopicTreeStore((state) => state.root);
  const setAllOpen = useTopicTreeStore((state) => state.setAllOpen);

  const branches = [...root.children.values()];

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

      {branches.length === 0 ? (
        <p className="empty">No topics yet. Connect to a broker and its tree builds here.</p>
      ) : (
        <div className={styles.tree}>
          {branches.map((child) => (
            <TreeNode key={child.name} node={child} path={child.name} depth={0} />
          ))}
        </div>
      )}
    </>
  );
}
