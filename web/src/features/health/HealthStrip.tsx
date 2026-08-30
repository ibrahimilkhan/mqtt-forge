import { useEffect, useRef, useState } from 'react';
import { heldWeight, useLogStore } from '../../stores/logStore';
import { useHealthStore } from '../../stores/healthStore';
import { useTopicTreeStore } from '../../stores/topicTreeStore';
import styles from './HealthStrip.module.css';

/** How often the line is worked out. Once a second: it is read, not watched. */
const EVERY_MS = 1000;

type Reading = {
  arriving: number;
  held: number;
  topics: number;
  weight: number;
  takingMs: number;
  fps: number;
  /** What the server's queue had to drop because this console was behind. */
  dropped: number;
};

/**
 * What the console is carrying, and what carrying it costs.
 *
 * Two costs rather than one, because they are not the same and the smaller is the one a
 * measurement usually finds. Taking a message in is a fraction of a millisecond however many
 * topics there are; drawing what arrived is the part that decides whether the console keeps up,
 * and the only honest way to report it is the rate frames are actually landing at.
 *
 * Everything here is counted by the console itself. The direct answers — `performance.memory`
 * and a long-task observer — exist only in Chrome, and the desktop build runs on the system
 * webview, so a line built on them would be blank exactly where it is most wanted.
 */
export function HealthStrip() {
  const [reading, setReading] = useState<Reading | null>(null);
  const frames = useRef(0);

  useEffect(() => {
    let frame = requestAnimationFrame(function tick() {
      frames.current += 1;
      frame = requestAnimationFrame(tick);
    });

    const timer = setInterval(() => {
      const { arrived, spentMs } = useHealthStore.getState().since();
      const drawn = frames.current;
      frames.current = 0;

      const log = useLogStore.getState();
      setReading({
        arriving: arrived,
        held: log.held,
        topics: useTopicTreeStore.getState().root.subTopics,
        weight: heldWeight(log.byTopic),
        takingMs: arrived > 0 ? spentMs : 0,
        fps: drawn,
        dropped: useHealthStore.getState().dropped,
      });
    }, EVERY_MS);

    return () => {
      cancelAnimationFrame(frame);
      clearInterval(timer);
    };
  }, []);

  return (
    <div className={styles.strip} role="status" aria-label="What the console is carrying">
      {reading === null ? (
        <span className={styles.quiet}>measuring…</span>
      ) : (
        <>
          {/* Every value is given the room its widest reading needs — see Cell. A line whose
              cells are laid out by the length of the numbers in them is a line that rearranges
              itself under the eye reading it, and this one is read by glancing at the same place
              twice. */}
          <Cell label="in" slot={7} value={`${count(reading.arriving)}/s`} />
          <Cell
            label="held"
            slot={18}
            value={`${count(reading.held)} on ${count(reading.topics)} topics`}
          />
          <Cell label="payload" slot={7} value={weigh(reading.weight)} />
          <Cell label="taking" slot={9} value={`${reading.takingMs.toFixed(1)} ms/s`} />
          {/* Only once there are any. A cell reading 'dropped 0' on every console that has never
              dropped anything is four characters of reassurance nobody asked for; one that
              appears is the line saying something went wrong. */}
          {reading.dropped > 0 && (
            <Cell label="dropped" slot={5} value={count(reading.dropped)} tense />
          )}
          {/* Last because it is the one that answers 'is this keeping up', and the eye should
              land on it after the numbers that explain it. */}
          <Cell label="drawing" slot={7} value={`${reading.fps} fps`} tense={reading.fps < 20} />
        </>
      )}
    </div>
  );
}

/**
 * One reading, in a slot the size of its own widest answer.
 *
 * `tabular-nums` holds the digits still and does nothing about the rest: '184' becomes '1.8k'
 * becomes '1.8M', 'B' becomes 'kB', and every one of those changes the width of the cell and
 * slides the four cells after it along. The slot is in `ch` — the width of a digit in this face —
 * so it grows with the reader's own type size rather than sitting still while the line around it
 * scales.
 */
function Cell({
  label,
  value,
  slot,
  tense = false,
}: {
  label: string;
  value: string;
  /** Characters of room for the value, at its longest. */
  slot: number;
  tense?: boolean;
}) {
  return (
    <span className={styles.cell} data-tense={tense ? '' : undefined}>
      <span className={styles.label}>{label}</span>
      <span className={styles.value} style={{ minWidth: `${slot}ch` }}>
        {value}
      </span>
    </span>
  );
}

/** Thousands as k, millions as M: the line is read at a glance, not audited. */
function count(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;

  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** The bodies as they are held, which is characters rather than bytes on the wire. */
function weigh(chars: number): string {
  if (chars < 1024) return `${chars} B`;
  if (chars < 1024 * 1024) return `${(chars / 1024).toFixed(0)} kB`;

  return `${(chars / 1024 / 1024).toFixed(1)} MB`;
}
