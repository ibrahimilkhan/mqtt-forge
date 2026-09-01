import { useMemo, useState, type CSSProperties } from 'react';
import { flattenTree } from '../../lib/topicTree';
import { treeFilter } from '../../lib/topicMatch';
import { useTopicTreeStore } from '../../stores/topicTreeStore';
import styles from './TopicPicker.module.css';

/**
 * The broker's own tree, offered where a topic filter is typed.
 *
 * A filter is the one field in this form the console already knows the answer to. Every topic the
 * broker has sent is two panels away in the workspace tree, and the reader was being asked to
 * remember one of them and spell it — including the level separators, including whether the
 * middle level is `+` or a name. A filter with a typo in it is a rule that saves and never fires,
 * which is the same silent failure a wrong field path causes, and it has the same cure: show them
 * what is there.
 *
 * Not the workspace's own `TopicTree`. That one is wired to the selection store, the publish
 * form and the traffic hold — picking a row in it re-aims the wire log and loads the compose
 * box, which is emphatically not what pressing a row inside a rule editor should do. This draws
 * the same data with one gesture attached to it: hand back a filter.
 *
 * A branch hands back `path/#`, which is what a branch means — everything under it. A leaf hands
 * back its own topic. A branch that also carries messages of its own is both, so it offers both.
 */

/** As many rows as the picker will draw before it stops. The tree's own cap, in a smaller box. */
const MOST_ROWS = 600;

export function TopicPicker({
  onPick,
  onClose,
}: {
  onPick: (filter: string) => void;
  onClose: () => void;
}) {
  const root = useTopicTreeStore((state) => state.root);

  /**
   * What is open, held here rather than in the tree store.
   *
   * Folding a branch to find something inside a rule editor must not fold it in the workspace
   * behind the panel: the reader would come back to a tree they had arranged and find it
   * rearranged by a form. So this keeps its own set, and it starts empty meaning 'everything
   * open' — a picker exists to show what there is, and one that opens folded shows a list of
   * top-level names and hides the answer.
   */
  const [shut, setShut] = useState<ReadonlySet<string>>(() => new Set());
  const [needle, setNeedle] = useState('');

  const { rows, hidden } = useMemo(
    () => flattenTree(root, (path) => !shut.has(path), MOST_ROWS),
    [root, shut],
  );

  /**
   * The rows a search leaves standing.
   *
   * A match on a branch keeps the branch, and a match on a leaf keeps the leaf — but a leaf whose
   * ancestors do not match would then be drawn under nothing, at an indent that means a parent
   * two rows up that is not there. So the whole path is searched rather than the segment: typing
   * `temp` keeps `plant/boiler/temp` and the branches above it are kept by the same test, because
   * their own paths are prefixes of a path that matched.
   */
  const shown = useMemo(() => {
    const term = needle.trim().toLowerCase();
    if (term === '') return rows;

    const keep = new Set<string>();
    for (const row of rows) {
      if (!row.path.toLowerCase().includes(term)) continue;

      // The row, and every branch above it, so the indent still describes something real.
      const parts = row.path.split('/');
      for (let level = 1; level <= parts.length; level++) keep.add(parts.slice(0, level).join('/'));
    }

    return rows.filter((row) => keep.has(row.path));
  }, [rows, needle]);

  const fold = (path: string) =>
    setShut((held) => {
      const next = new Set(held);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  return (
    <div className={styles.picker} role="group" aria-label="Topics on the broker">
      <div className={styles.head}>
        <input
          type="text"
          className={styles.needle}
          value={needle}
          spellCheck={false}
          placeholder="Find a topic"
          aria-label="Find a topic"
          onChange={(event) => setNeedle(event.target.value)}
        />
        <button type="button" className="ghost" onClick={onClose}>
          Close
        </button>
      </div>

      {root.subTopics === 0 ? (
        <p className="empty">
          Nothing has arrived yet. Connect to a broker and its topics are listed here.
        </p>
      ) : shown.length === 0 ? (
        <p className="empty">No topic here carries &lsquo;{needle.trim()}&rsquo;.</p>
      ) : (
        <div className={styles.rows}>
          {shown.map((row) => (
            <div key={row.path} className={styles.row} style={{ '--depth': row.depth } as CSSProperties}>
              {row.isBranch ? (
                <button
                  type="button"
                  className={styles.twisty}
                  data-open={!shut.has(row.path)}
                  aria-label={`${shut.has(row.path) ? 'Expand' : 'Collapse'} ${row.path}`}
                  onClick={() => fold(row.path)}
                >
                  ▾
                </button>
              ) : (
                <span className={styles.twisty} aria-hidden="true" />
              )}

              {/* A branch offers the subtree; a branch that has spoken offers itself as well, and
                  a leaf offers only itself. Two buttons rather than one that guesses: 'everything
                  under plant/boiler' and 'plant/boiler itself' are different rules, and which of
                  them somebody meant is not something a click count can be trusted to say. */}
              {row.isBranch && (
                <button
                  type="button"
                  className={styles.pick}
                  onClick={() => onPick(treeFilter(row.path))}
                >
                  <span className={styles.seg}>{row.node.name || '/'}</span>
                  <span className={styles.wildcard}>/#</span>
                </button>
              )}

              {(!row.isBranch || row.node.hits > 0) && (
                <button
                  type="button"
                  className={row.isBranch ? `${styles.pick} ${styles.self}` : styles.pick}
                  onClick={() => onPick(row.path)}
                >
                  <span className={styles.seg}>
                    {row.isBranch ? 'this topic only' : row.node.name || '/'}
                  </span>
                  <span className={styles.val}>{row.node.latestPayload ?? ''}</span>
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {hidden > 0 && (
        <p className={styles.capped}>
          {hidden} more {hidden === 1 ? 'topic' : 'topics'} not listed. Narrow the search above.
        </p>
      )}
    </div>
  );
}
