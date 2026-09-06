import { WHERE_OPTIONS, type Where } from '../lib/sift';
import styles from './SearchBox.module.css';

/**
 * Where a search looks: the topic, the message, or both.
 *
 * A select rather than the console's usual row of chips, and for once the dropdown is right: the
 * three options are one setting on a search that is already two controls wide, in a strip that
 * has to fit inside a pane. A row of three chips beside the box would be wider than the box.
 *
 * It ships on 'Both', which is what a reader who has not thought about it means. The choice is
 * worth having because the two searches genuinely differ: `error` in the topics finds the topics
 * named for errors, and `error` in the messages finds the ones reporting them.
 */
export function WhereSelect({
  label,
  value,
  onChange,
}: {
  /** The accessible name — 'Search the log in'. Never drawn: the box beside it says the rest. */
  label: string;
  value: Where;
  onChange: (where: Where) => void;
}) {
  return (
    <select
      className={styles.where}
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value as Where)}
    >
      {WHERE_OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
