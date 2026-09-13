import { memo, useRef, type CSSProperties, type ReactNode } from 'react';
import type { ColourRule } from '../../lib/topicColour';
import { EMPTY_LEVEL, nodeSummary, type TopicNode } from '../../lib/topicTree';
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
  /** Whether this is the broker's own row, with a live link behind it. It fills, faintly. */
  root?: boolean;
  /** Controls parked at the row's right end. Siblings of the pick button, never inside it. */
  actions?: ReactNode;
  onToggle: (path: string) => void;
  onSelect: (path: string, node: TopicNode) => void;
};

/**
 * A colour this row is willing to paint with.
 *
 * The rules file is the reader's and can be hand-edited, so what arrives here is a string and not
 * necessarily a colour. It used to reach a `style={{ color }}` and be rejected by the browser,
 * which is a safety net rather than a decision — and it never covered `--rule-colour`, which the
 * row has always set from the same unchecked string for the selected stripe to draw itself in.
 * Checked once, here, so the stripe, the sparkline and the name all take the same answer.
 */
const HEX = /^#[0-9a-f]{6}$/i;

function paintable(colour: string | null | undefined): string | undefined {
  return colour && HEX.test(colour) ? colour : undefined;
}

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
  root = false,
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

  /** Whether the click run in progress is the one that opened this branch. See the click below. */
  const openedRun = useRef(false);

  /** The rule's colour, once — the row, the name and the sparkline all draw from this one answer. */
  const paint = paintable(rule?.colour);

  return (
    <div
      className={styles.node}
      data-testid="tree-row"
      data-open={open}
      data-branch={isBranch}
      data-active={active}
      data-selected={selected}
      data-root={root ? '' : undefined}
      data-depth={depth}
      style={rowStyle(depth, paint)}
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
        // One click opens a shut branch; two fold an open one.
        //
        // Opening used to take two as well, and a branch that only opens on the second click is
        // one most readers never learn opens at all. Folding keeps the pair, because the two are
        // not the same risk: a reader clicks a branch to look at what is under it, so a single
        // click that shut it would hide the thing they had just asked for. Asking for it back is
        // a deliberate gesture, and a deliberate gesture can cost two clicks.
        //
        // The count is the browser's, and the browser does not restart it while the pointer
        // stays put: a second double click in the same spot arrives as clicks three and four.
        // So the odd ones — and the countless zero an Enter on a focused row arrives with — are
        // read as the start of a gesture, and each even one as the second half of the pair
        // before it. `openedRun` is what that pair means: a pair that began on a shut branch has
        // already opened it and must not shut it again, and one that began on an open branch is
        // the fold. Without it, double-clicking a shut branch opened and shut it in one gesture.
        onClick={(event) => {
          const pair = event.detail !== 0 && event.detail % 2 === 0;

          // The repeat click belongs to the pair rather than to the reader: passing it on would
          // load the topic into publish a second time, over whatever had been typed since.
          if (!pair) onSelect(path, node);

          // A quick second click starts a selection run, which would leave the topic highlighted
          // behind the row. Above the branch test, because a leaf is a row a reader double
          // clicks too — the name is selectable on purpose — and the leaf path used to return
          // before this and leave the highlight standing.
          window.getSelection()?.removeAllRanges();
          if (!isBranch) return;

          if (!pair) {
            openedRun.current = !open;
            if (!open) onToggle(path);
            return;
          }

          if (!openedRun.current) onToggle(path);
        }}
      >
        {/* The rule paints the segment itself rather than a mark beside it: nothing is added to
            the row, so no width shifts as rules come and go, and what the colour is about — this
            topic — is the thing wearing it. The title names the filter, not the topic: the topic
            is already on the row, and with rules overlapping, which one won is the open question. */}
        <span
          className={nameless ? `${styles.seg} ${styles.empty}` : styles.seg}
          data-testid="segment"
          // The colour comes off the row's own `--rule-colour` rather than being written here.
          // An inline colour is the one thing a stylesheet cannot answer, and the selected row
          // has to answer it: it is the only row that fills, and every one of these colours is
          // tuned against the white the others stand on. See TopicTree.module.css.
          data-ruled={paint ? '' : undefined}
          title={paint ? `Coloured by ${rule!.filter}` : undefined}
        >
          {nameless ? EMPTY_LEVEL : segment}
        </span>
        <span className={styles.val}>{node.latestPayload ?? ''}</span>
        {/* Between the value and the counts: what the topic has been doing, for a reader
            scanning the tree rather than reading one row of it. */}
        <Sparkline readings={node.readings} colour={paint} />
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
function rowStyle(depth: number, colour?: string): CSSProperties {
  return { '--depth': depth, ...(colour && { '--rule-colour': colour }) } as CSSProperties;
}
