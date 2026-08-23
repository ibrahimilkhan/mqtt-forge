import styles from './Segmented.module.css';

type Option<T extends string> = { value: T; label: string };

type Props<T extends string> = {
  /** Over the row, in the same voice as a field's label. */
  label: string;
  /** Unique on the page: this is the radio group's name and the row's accessible name. */
  name: string;
  options: readonly Option<T>[];
  value: T;
  onChange: (value: T) => void;
  /** One line under the row, about whichever option is chosen. */
  note?: string;
};

/**
 * A short, fixed set of choices, all of them worth reading at once.
 *
 * A `<select>` would take less room and be worse: these are three and four options that a
 * reader is choosing BETWEEN — mqtt against wss, 5.0 against 3.1.1 — and a dropdown hides the
 * alternatives behind the one already picked, which is exactly the comparison being made. It
 * also puts the note under the row rather than beside the chosen chip, so switching between two
 * options reads as one line changing rather than the layout moving.
 *
 * Radios underneath, so arrow keys move through the group and a screen reader is told what it
 * is; the chips are the labels wearing the state.
 */
export function Segmented<T extends string>({ label, name, options, value, onChange, note }: Props<T>) {
  return (
    <div className={styles.group}>
      <span className={styles.label} id={`${name}Label`}>
        {label}
      </span>
      <div className={styles.options} role="radiogroup" aria-labelledby={`${name}Label`}>
        {options.map((option) => (
          <label key={option.value} className={styles.option} data-selected={option.value === value}>
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={option.value === value}
              onChange={() => onChange(option.value)}
            />
            {option.label}
          </label>
        ))}
      </div>
      {note && <p className={styles.note}>{note}</p>}
    </div>
  );
}
