import { useMemo, useState } from 'react';
import { useFlowStatusStore } from '../../stores/flowStatusStore';
import type { FlowDto } from '../../types/api';
import { NODE_SPECS } from './nodeTypes';
import styles from './DebugStrip.module.css';

const OPEN_KEY = 'mqttforge.flows.debugOpen';

const readOpen = () => {
  try {
    return localStorage.getItem(OPEN_KEY) !== '0';
  } catch {
    return true;
  }
};

/** Hours, minutes and seconds: these lines are about the last minute. */
const clock = (at: string) =>
  new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

/**
 * What the flow on screen printed and what went wrong in it, newest first.
 *
 * Only this flow's lines: a reader looking at one flow and reading another's is reading noise.
 * The store keeps every flow's, so switching tabs shows the other flow's lines at once.
 */
export function DebugStrip({ flow }: { flow: FlowDto }) {
  const debug = useFlowStatusStore((state) => state.debug);
  const dropped = useFlowStatusStore((state) => state.debugDropped);
  const clear = useFlowStatusStore((state) => state.clearDebug);
  const [open, setOpen] = useState(readOpen);

  const lines = useMemo(() => debug.filter((entry) => entry.flowId === flow.id), [debug, flow.id]);
  const labelOf = (nodeId: string) => {
    const node = flow.nodes.find((one) => one.id === nodeId);
    return node ? NODE_SPECS[node.type].label : nodeId;
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
        <button type="button" className={styles.fold} aria-expanded={open} onClick={toggle}>
          <span aria-hidden="true">{open ? '▾' : '▸'}</span> Debug <span className={styles.count}>{lines.length}</span>
        </button>
        {dropped > 0 && <span className={styles.dropped}>{dropped} left out</span>}
        {open && lines.length > 0 && (
          <button type="button" className="ghost ends" onClick={clear}>
            Clear
          </button>
        )}
      </div>

      {open &&
        (lines.length === 0 ? (
          <p className={styles.empty}>Nothing yet. What a Debug node is given is printed here, and so is anything that goes wrong.</p>
        ) : (
          <ol className={styles.lines}>
            {lines.map((entry, index) => (
              <li key={`${entry.at}-${index}`} className={styles.line} data-kind={entry.kind}>
                <time className={styles.time} dateTime={entry.at}>
                  {clock(entry.at)}
                </time>
                <span className={styles.node}>{labelOf(entry.nodeId)}</span>
                {entry.topic && <span className={styles.topic}>{entry.topic}</span>}
                <span className={styles.text}>{entry.text}</span>
              </li>
            ))}
          </ol>
        ))}
    </section>
  );
}
