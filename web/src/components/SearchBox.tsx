import { useEffect, useRef } from 'react';
import { Search } from '../features/brand/icons';
import styles from './SearchBox.module.css';

type Props = {
  /** The box's accessible name — 'Search the topics', 'Search the log'. Never drawn. */
  label: string;
  value: string;
  onChange: (look: string) => void;
  /** What the box says when it is empty. Kept short: these boxes are narrow. */
  placeholder?: string;
  /** Takes the caret when it appears, which is what the reader pressed the mark for. */
  focused?: boolean;
};

/**
 * The console's one search box.
 *
 * Every pane that offers a search offers this, so that what the reader learns in one of them
 * holds in the rest: plain text, matched as it is typed, cleared by the cross at its end.
 *
 * No label above it. Each of these stands in a row of controls beside the pane's own name, and
 * the name is what says which pane is being searched; a second word over the box would say it
 * twice and cost the row a line. The name is on the input for anything not reading the screen.
 */
export function SearchBox({ label, value, onChange, placeholder = 'Search', focused }: Props) {
  const box = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focused) box.current?.focus();
  }, [focused]);

  return (
    <div className={styles.box}>
      <span className={styles.mark} aria-hidden="true">
        <Search />
      </span>
      <input
        ref={box}
        type="search"
        className={styles.input}
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {value !== '' && (
        <button
          type="button"
          className={styles.clear}
          aria-label={`Clear ${label.toLowerCase()}`}
          onClick={() => onChange('')}
        >
          ×
        </button>
      )}
    </div>
  );
}

/**
 * The mark that opens a search, and closes it again.
 *
 * The box is behind it rather than always on screen. A search box standing open in every pane is
 * a control the reader has to look past to read the thing they came for — three of them, in a
 * console whose panes are already narrow — and it says 'search me' to a reader who has not asked
 * anything. The mark says the same thing in sixteen pixels, and hands the caret over when pressed.
 *
 * Closing it lets the search go. A box that hid itself while still narrowing what is drawn would
 * leave a pane quietly holding rows back with nothing on screen to say so.
 */
export function SearchOpener({
  label,
  open,
  onToggle,
}: {
  /** What it opens — 'Find a topic', 'Find in the log'. */
  label: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={styles.opener}
      aria-label={label}
      aria-expanded={open}
      title={label}
      onClick={onToggle}
    >
      <Search />
    </button>
  );
}
