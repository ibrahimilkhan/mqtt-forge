import { Pause, Play } from './PauseGlyphs';
import styles from './HoldButton.module.css';
import { useHoldControl } from './useTraffic';

/**
 * Stops one run where it is, and says how much went past while it was stopped.
 *
 * The narrow pause. What it stops is a pane redrawing: the broker carries on, the tree carries
 * on counting, every other pane carries on — which is the point of it, and is what tells it
 * apart from the one in the rail that stops the console taking messages at all.
 *
 * It rides on the selected row of the topic tree, at that row's right end. It used to stand in
 * the log's foot, which is one of the panes it holds but not the thing it is about: what it
 * holds is the run the selection put on screen, and the selection is a row in the tree. On the
 * row, the control and the thing it acts on are the same object — and there is exactly one,
 * because there is exactly one selected row.
 *
 * Nothing is drawn when no topic has been picked: there is no run to hold, and a dead control
 * reads as something broken rather than as something waiting.
 */
export function HoldButton() {
  const { can, held, arrived, toggle } = useHoldControl();

  if (!can) return null;

  const waiting = held && arrived > 0;

  return (
    <button
      type="button"
      className={styles.hold}
      aria-pressed={held}
      aria-label={
        held
          ? waiting
            ? `Let the pane go, ${arrived} arrived while it was paused`
            : 'Let the pane go'
          : 'Pause the pane'
      }
      title={
        held
          ? waiting
            ? `Paused — ${arrived} arrived behind it. Click to catch up.`
            : 'Paused — the traffic is still arriving behind it. Click to catch up.'
          : 'Pause the pane — the rows stop where they are, and the traffic behind them carries on arriving'
      }
      onClick={toggle}
    >
      {held ? <Play /> : <Pause />}
      {/* A count of nothing is not news. */}
      {waiting && <span>{arrived}</span>}
    </button>
  );
}
