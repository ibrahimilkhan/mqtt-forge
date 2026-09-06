import { Search } from '../features/brand/icons';
import styles from './SearchBox.module.css';

type Props = {
  /** The box's accessible name — 'Search broker events', 'Search the log'. Never drawn. */
  label: string;
  value: string;
  onChange: (look: string) => void;
  /** What the box says when it is empty. Kept short: these boxes are narrow. */
  placeholder?: string;
};

/**
 * The console's one search box.
 *
 * Every pane that offers a search offers this, so that what the reader learns in one of them
 * holds in the rest: plain text, matched as it is typed, cleared by the cross at its end.
 *
 * No label above it. Each of these stands in a header strip beside the pane's own title, and the
 * title is what says which pane is being searched; a second word over the box would say it twice
 * and cost the strip a line. The name is on the input for anything not reading the screen.
 */
export function SearchBox({ label, value, onChange, placeholder = 'Search' }: Props) {
  return (
    <div className={styles.box}>
      <span className={styles.mark} aria-hidden="true">
        <Search />
      </span>
      <input
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
