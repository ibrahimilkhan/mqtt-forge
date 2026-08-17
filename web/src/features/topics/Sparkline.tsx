import { memo } from 'react';
import { short } from '../../lib/format';
import styles from './TopicTree.module.css';

/** Two points make a line; three is where a shape starts being one. */
const ENOUGH = 3;

/** Drawn small and fixed, so a column of them can be compared down the tree. */
const WIDE = 40;
const TALL = 12;

/**
 * The shape of a topic's last few readings, on its own row.
 *
 * Finding what is moving on a broker means opening every numeric topic in turn, in every other
 * console there is. A thumbnail on the row answers the same question by being scanned: a flat
 * line is a sensor at rest, a sawtooth is one cycling, a step is one that changed. What it does
 * not do is carry numbers — the pane below is where a reading is read.
 */
export const Sparkline = memo(function Sparkline({
  readings,
  colour,
}: {
  readings: readonly number[];
  colour?: string;
}) {
  if (readings.length < ENOUGH) return null;

  const low = Math.min(...readings);
  const high = Math.max(...readings);
  const span = high - low;

  // A run that never moved is drawn down the middle rather than divided by its own zero span.
  const y = (value: number) =>
    span === 0 ? TALL / 2 : TALL - 1 - ((value - low) / span) * (TALL - 2);
  const x = (index: number) => (index / (readings.length - 1)) * WIDE;

  return (
    <svg
      className={styles.spark}
      data-testid="spark"
      width={WIDE}
      height={TALL}
      viewBox={`0 0 ${WIDE} ${TALL}`}
      role="img"
      // The row already says which topic this is; what the picture adds is how much of a run it
      // is and how far it ranges, which is what a reader cannot get from the shape alone.
      aria-label={`${readings.length} readings, ${short(low)} to ${short(high)}`}
    >
      <polyline
        points={readings.map((value, index) => `${x(index)},${y(value)}`).join(' ')}
        fill="none"
        stroke={colour ?? 'currentColor'}
      />
    </svg>
  );
});
