import { memo, type CSSProperties, type ReactNode } from 'react';
import type { ColourRule } from '../../lib/topicColour';
import { nodeSummary, type TopicNode } from '../../lib/topicTree';
import { Sparkline } from './Sparkline';
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

/**
 * What stands in for a level with no name of its own.
 *
 * A topic beginning with '/' has an empty first level, and one written 'a//b' an empty middle
 * one — real levels either way: they are part of the topic, and they open and pick like any
 * other row. Drawn blank they read as a row that failed to render, so they are drawn as the
 * slash that implies them, in muted ink so it is plainly a mark and not a segment named '/'.
 */
export const EMPTY_LEVEL = '/';

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
  // The broker row carries a label and is not a topic; every other row is its own segment.
  const segment = label ?? node.name;
  const nameless = segment === '';
  // The twisty names the row it opens, and the empty first level's path is '' — so without this
  // it was told to 'Collapse ', an instruction naming nothing.
  const spoken = label ?? (path === '' ? EMPTY_LEVEL : path);

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
          aria-label={`${open ? 'Collapse' : 'Expand'} ${spoken}`}
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
        // One click, and the row does both the things it is for: it becomes what the wire log is
        // about, and — if it is a shut branch — it opens.
        //
        // It used to take two, counted off `event.detail` rather than read from a dblclick
        // handler. The twisty is a 10px glyph at the far left of an indented row, so the row
        // carried the same instruction for anyone who would rather not aim at it; but a branch
        // that only opens on the second click is a branch most readers never learn opens at all,
        // and the first click had already done something else, which made the second read as a
        // correction rather than as an instruction of its own.
        //
        // It opens and it does not shut. Shutting belongs to the twisty, which is on the row and
        // says which state it is in. A row that toggled would close half the times a reader
        // clicked it to watch what is under it, and a click that sometimes hides what was asked
        // for is worse than one that always shows it.
        onClick={() => {
          onSelect(path, node);
          if (!isBranch || open) return;

          // A quick second click still starts a selection run, which would leave the segment
          // highlighted behind the row.
          window.getSelection()?.removeAllRanges();
          onToggle(path);
        }}
      >
        {/* The rule paints the segment itself rather than a mark beside it: nothing is added to
            the row, so no width shifts as rules come and go, and what the colour is about — this
            topic — is the thing wearing it. The title names the filter, not the topic: the topic
            is already on the row, and with rules overlapping, which one won is the open question. */}
        <span
          className={nameless ? `${styles.seg} ${styles.empty}` : styles.seg}
          data-testid="segment"
          style={rule ? { color: rule.colour } : undefined}
          title={rule ? `Coloured by ${rule.filter}` : undefined}
        >
          {nameless ? EMPTY_LEVEL : segment}
        </span>
        <span className={styles.val}>{node.latestPayload ?? ''}</span>
        {/* Between the value and the counts: what the topic has been doing, for a reader
            scanning the tree rather than reading one row of it. */}
        <Sparkline readings={node.readings} colour={rule?.colour} />
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
