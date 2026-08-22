import { useEffect, useReducer } from 'react';
import { usePauseStore } from '../../stores/pauseStore';
import { Play, Pause } from './PauseGlyphs';
import styles from './StreamPause.module.css';

/** How often the size of the queue is re-read while there is a queue. */
const EVERY_MS = 500;

type Props = {
  compact?: boolean;
  /** Whether there is a broker on the other end. Nothing to stop without one. */
  live?: boolean;
};

/**
 * Stops the console taking messages in at all, and says how many went past while it was stopped.
 *
 * At the foot of the rail, because what it stops is the whole console rather than any one pane —
 * the tree stops growing, the log stops filling, every chart holds still. The other pause, in the
 * log's foot, is the one that stops a single run from redrawing while everything else carries on.
 *
 * Coloured while it is on, and filled rather than outlined. A console showing numbers that are
 * no longer arriving is the one state where being quiet would be the wrong manner: it looks
 * exactly like a console showing numbers that are.
 *
 * The figure beside the word is the queue: how many are waiting to be taken in while it is
 * stopped, and how many are still to land while the queue drains after it is let go. Nothing in
 * it is thrown away, so it is a promise rather than a regret.
 */
export function StreamPause({ compact = false, live = false }: Props) {
  const paused = usePauseStore((state) => state.paused);
  const toggle = usePauseStore((state) => state.toggle);

  // Nothing is arriving with no broker on the other end, so there is nothing to stop: the
  // control is out of reach rather than offering an act with no effect. Stopped, it stays
  // reachable however the link is — otherwise a console that lost its broker while held would
  // have no way back, and would sit there ignoring the traffic when the link came up again.
  const idle = !live && !paused;

  // The queue's size is written without telling anyone, so that a message costs nothing to take
  // in. This is what asks for it, twice a second, and only while there is something to ask
  // about: while it is stopped, and while what stopping collected is still coming in.
  const [, reread] = useReducer((n: number) => n + 1, 0);
  const waiting = usePauseStore.getState().waiting;
  const lost = usePauseStore.getState().lost;
  const queued = paused || waiting > 0;

  useEffect(() => {
    if (!queued) return;

    const timer = setInterval(reread, EVERY_MS);
    return () => clearInterval(timer);
  }, [queued]);

  return (
    <button
      type="button"
      className={styles.stream}
      data-compact={compact ? '' : undefined}
      disabled={idle}
      aria-pressed={paused}
      aria-label={
        paused
          ? waiting > 0
            ? `Take messages again, ${waiting} waiting`
            : 'Take messages again'
          : 'Stop taking messages'
      }
      title={
        idle
          ? 'Nothing to stop — the console is not connected to a broker'
          : paused
            ? waiting > 0
              ? `Stopped — ${waiting} waiting${lost > 0 ? `, ${lost} past the ceiling and dropped` : ''}. Click to take them in.`
              : 'Stopped — nothing is reaching the log, the tree or the charts. Click to start again.'
            : waiting > 0
              ? `${waiting} still coming in. Click to stop again — what is left stays queued.`
              : 'Stop taking messages — the console holds still, and what arrives meanwhile is queued rather than lost'
      }
      onClick={toggle}
    >
      {paused ? <Play /> : <Pause />}
      {/* Open, the control says what pressing it does. A red box with two bars in it is a pause
          symbol to anyone who has used a transport control and a red box to everyone else. */}
      {!compact && <span>{paused ? 'Resume' : 'Stop stream'}</span>}
      {waiting > 0 && !compact && <span className={styles.count}>{format(waiting)}</span>}
    </button>
  );
}

/** Thousands as k: this is read at a glance, and the exact figure is in the tooltip. */
const format = (n: number): string => (n < 1000 ? String(n) : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`);
