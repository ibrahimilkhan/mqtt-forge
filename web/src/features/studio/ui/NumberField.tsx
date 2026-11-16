import { useEffect, useState, type KeyboardEvent } from 'react';
import { evalExpr } from '../units/evalExpr';
import { roundTo, type DisplayUnit } from '../units/units';
import styles from './Inspector.module.css';

type Props = {
  label: string;
  value: number;
  onCommit: (value: number) => void;
  /** A length field accepts units after numbers ('10cm+2mm'), answered in `unit`. */
  length?: boolean;
  unit?: DisplayUnit;
  step?: number;
  digits?: number;
};

/**
 * A number box that takes arithmetic as well as numbers — '1200/2', '+50' to add to what is there,
 * '10cm' in a length field — worked out on Enter or on leaving the box, and stepped with the arrow
 * keys. Text it cannot read goes back to the value rather than becoming zero.
 */
export function NumberField({ label, value, onCommit, length = false, unit = 'm', step = 1, digits = 4 }: Props) {
  const shown = String(roundTo(value, digits));
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);

  const commit = () => {
    if (text === shown) return;
    const result = evalExpr(text, { current: value, length, unit });
    if (Number.isNaN(result)) setText(shown);
    else onCommit(result);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') commit();
    else if (event.key === 'Escape') setText(shown);
    else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      const by = step * (event.shiftKey ? 10 : 1) * (event.key === 'ArrowUp' ? 1 : -1);
      onCommit(roundTo(value + by, 6));
    }
  };

  return (
    <label className={styles.number}>
      <span className={styles.numberLabel}>{label.split(' ').at(-1)}</span>
      <input
        type="text"
        inputMode="decimal"
        aria-label={label}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
      />
    </label>
  );
}
