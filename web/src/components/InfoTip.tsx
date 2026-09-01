import type { ReactNode } from 'react';
import { Info } from '../features/brand/icons';
import styles from './InfoTip.module.css';

/**
 * The explanation a form is allowed to leave out, kept one press away.
 *
 * A rule editor has ten condition types, a path syntax and four channels in it, and every one of
 * them was carrying its own sentence of prose under the field. Twenty sentences is a form nobody
 * reads and nobody can find anything in — the fields disappear into the explanation of the
 * fields. So the prose comes out of the flow and goes behind a mark: a reader who already knows
 * what a cooldown is sees a form of boxes, and a reader who does not is one press from the
 * paragraph they need.
 *
 * Not a tooltip, deliberately. What is behind these marks is two paragraphs and a worked example
 * with a code block in it — that is a thing you read, and a box that vanishes when the pointer
 * moves is not a thing you can read. It opens, it stays open, and it closes when it is closed.
 *
 * Not a `<details>` either, and the mark is kept apart from the body it opens. Every one of these
 * hangs off a row — a `<legend>`, a field's label line, a line of switches — and the body has to
 * land UNDER that row rather than inside it. A convenience component that rendered both together
 * was tried and drawn twice as a thirty-line paragraph laid out as one flex item beside a label,
 * two words wide. Two pieces, and the caller says where each goes.
 */

/** The press. Controlled, so the body it opens can be rendered anywhere the caller likes. */
export function InfoMark({
  label,
  open,
  controls,
  onToggle,
}: {
  /** What is being explained, as it is written on screen: 'When it fires', 'Field'. */
  label: string;
  open: boolean;
  /** The id of the body this opens, so a screen reader can be taken to it. */
  controls?: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={styles.mark}
      aria-expanded={open}
      aria-controls={controls}
      // The name says what pressing it does, both ways round. 'Info' would be a button named
      // after its own picture.
      aria-label={open ? `Hide what ${label} means` : `What ${label} means`}
      title={open ? `Hide what ${label} means` : `What ${label} means`}
      onClick={onToggle}
    >
      <Info />
    </button>
  );
}

/** The paragraph. A region rather than a plain div, so it can be reached and left again. */
export function InfoBody({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <div id={id} className={styles.body} role="note">
      {children}
    </div>
  );
}

/**
 * One line of a worked example: a path, and what it reads out of the document above it.
 *
 * A table rather than prose, because the whole point being made is a correspondence — this
 * expression, that value — and prose makes a reader hold both halves in their head while they
 * find the second one.
 */
export function Example({ rows }: { rows: ReadonlyArray<[string, string]> }) {
  return (
    <dl className={styles.example}>
      {rows.map(([path, reads]) => (
        <div key={path} className={styles.exampleRow}>
          <dt>{path}</dt>
          <dd>{reads}</dd>
        </div>
      ))}
    </dl>
  );
}
