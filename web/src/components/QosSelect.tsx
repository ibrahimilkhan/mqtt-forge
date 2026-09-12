import styles from './QosSelect.module.css';

type Props = { name: string; value: number; onChange: (qos: number) => void };

/**
 * The three levels, under one word.
 *
 * Each option used to carry the whole name — QoS 0, QoS 1, QoS 2 — which is the name of the thing
 * printed on every value of it. What a reader is choosing between is 0, 1 and 2; the word is what
 * they have in common, so it is said once, in front of them, in the voice a field label uses.
 *
 * The radios keep the full name for anyone who is not looking at the row: a control announced as
 * '0' is a control nobody can place. The group carries it too, so a screen reader meets the word
 * on the way in.
 */
export function QosSelect({ name, value, onChange }: Props) {
  return (
    <div className={styles.group} role="radiogroup" aria-label="QoS">
      <span className={styles.name} aria-hidden="true">
        QoS
      </span>
      {[0, 1, 2].map((level) => (
        <label key={level}>
          <input
            type="radio"
            name={name}
            value={level}
            aria-label={`QoS ${level}`}
            checked={value === level}
            onChange={() => onChange(level)}
          />
          {` ${level}`}
        </label>
      ))}
    </div>
  );
}
