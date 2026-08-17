import { memo, type CSSProperties, type ReactNode } from 'react';
import type { ColourRule } from '../../lib/topicColour';
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
  /** The colour rule covering this row's topic, or null when none does. */
  rule?: ColourRule | null;
  /** Controls parked at the row's right end. Siblings of the pick button, never inside it. */
  actions?: ReactNode;
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
  rule,
  actions,
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
      style={rowStyle(depth, rule)}
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
        {/* The rule paints the segment itself rather than a mark beside it: nothing is added to
            the row, so no width shifts as rules come and go, and what the colour is about — this
            topic — is the thing wearing it. The title names the filter, not the topic: the topic
            is already on the row, and with rules overlapping, which one won is the open question. */}
        <span
          className={styles.seg}
          data-testid="segment"
          style={rule ? { color: rule.colour } : undefined}
          title={rule ? `Coloured by ${rule.filter}` : undefined}
        >
          {label ?? node.name}
        </span>
        <span className={styles.val}>{node.latestPayload ?? ''}</span>
        <span className={styles.meta}>{nodeSummary(node)}</span>
      </button>

      {actions}
    </div>
  );
});

/**
 * The row's indent, and the rule's colour when one covers it.
 *
 * `--rule-colour` is left unset rather than set to something neutral, so the stripe the selected
 * row draws can name its own fallback: a custom property that is absent takes the fallback in
 * `var()`, one set to an empty value does not.
 */
function rowStyle(depth: number, rule?: ColourRule | null): CSSProperties {
  return { '--depth': depth, ...(rule && { '--rule-colour': rule.colour }) } as CSSProperties;
}
