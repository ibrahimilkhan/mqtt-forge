import { useRef, useState } from 'react';
import { leftOut, useFlowStatusStore, type DebugLine } from '../../stores/flowStatusStore';
import type { FlowDto } from '../../types/api';
import { specOf } from './nodeTypes';
import styles from './DebugStrip.module.css';

const OPEN_KEY = 'mqttforge.flows.debugOpen';

const readOpen = () => {
  try {
    return localStorage.getItem(OPEN_KEY) !== '0';
  } catch {
    return true;
  }
};

/** A flow with no lines. One array, so the store's answer is the same one each time it is asked. */
const NO_LINES: DebugLine[] = [];

/** Hours, minutes and seconds: these lines are about the last minute. */
const clock = (at: string) =>
  new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

/**
 * What the flow on screen printed and what went wrong in it, newest first.
 *
 * Only this flow's lines: a reader looking at one flow and reading another's is reading noise.
 * The store keeps every flow's, each to its own last 200, so switching tabs shows the other
 * flow's lines at once, and Clear empties this flow's and no other's.
 *
 * What the server left out it counts but does not attribute, so that figure is said as the whole
 * console's, not as this flow's.
 */
export function DebugStrip({ flow }: { flow: FlowDto }) {
  const lines = useFlowStatusStore((state) => state.debug[flow.id] ?? NO_LINES);
  const dropped = useFlowStatusStore((state) => leftOut(state, flow.id));
  const clear = useFlowStatusStore((state) => state.clearDebug);
  const [open, setOpen] = useState(readOpen);
  const fold = useRef<HTMLButtonElement>(null);

  const labelOf = (nodeId: string) => {
    const node = flow.nodes.find((one) => one.id === nodeId);
    return node ? specOf(node.type).label : nodeId;
  };

  const toggle = () =>
    setOpen((was) => {
      try {
        localStorage.setItem(OPEN_KEY, was ? '0' : '1');
      } catch {
        // The fold is only remembered where it can be.
      }
      return !was;
    });

  return (
    <section className={styles.debug} data-open={open ? '' : undefined} aria-label="Debug">
      <div className={styles.head}>
        <button ref={fold} type="button" className={styles.fold} aria-expanded={open} onClick={toggle}>
          <span aria-hidden="true">{open ? '▾' : '▸'}</span> Debug <span className={styles.count}>{lines.length}</span>
        </button>
        {dropped > 0 && <span className={styles.dropped}>{dropped} left out, from any flow</span>}
        {open && (lines.length > 0 || dropped > 0) && (
          <button
            type="button"
            className="ghost ends"
            onClick={() => {
              // Clear goes with what it cleared, and the keyboard with it; the fold stays.
              clear(flow.id);
              fold.current?.focus();
            }}
          >
            Clear
          </button>
        )}
      </div>

      {open &&
        (lines.length === 0 ? (
          <p className={styles.empty}>Nothing yet. What a Debug node is given is printed here, and so is anything that goes wrong.</p>
        ) : (
          <ol className={styles.lines}>
            {lines.map((entry) => (
              <li key={entry.seq} className={styles.line} data-kind={entry.kind}>
                <time className={styles.time} dateTime={entry.at}>
                  {clock(entry.at)}
                </time>
                <span className={styles.node}>{labelOf(entry.nodeId)}</span>
                {/* A message with nothing in it is still a message, and says what it was missing:
                    a line of only a time and a node reads as one that failed to draw. What went
                    wrong is not a message, so an error with no topic is missing nothing. */}
                {entry.topic ? (
                  <span className={styles.topic}>{entry.topic}</span>
                ) : (
                  entry.kind === 'message' && <span className={`${styles.topic} ${styles.none}`}>no topic</span>
                )}
                {entry.text || entry.kind === 'error' ? (
                  <span className={styles.text}>{entry.text}</span>
                ) : (
                  <span className={`${styles.text} ${styles.none}`}>empty payload</span>
                )}
              </li>
            ))}
          </ol>
        ))}
    </section>
  );
}
