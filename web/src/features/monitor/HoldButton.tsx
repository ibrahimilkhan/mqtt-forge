import { holdName } from '../../lib/holds';
import { Pause, Play } from './PauseGlyphs';
import styles from './HoldButton.module.css';
import { useHoldControl } from './useTraffic';

/**
 * Stops one run where it is, and says how much went past while it was stopped.
 *
 * The narrow pause. What it stops is a pane redrawing: the broker carries on, the rows it does not
 * cover carry on counting, every other pane carries on — which is the point of it, and is what
 * tells it apart from the one in the rail that stops the console taking messages at all.
 *
 * It rides on the selected row of the topic tree, at that row's right end, and on every row that
 * has a hold of its own wherever the reader has gone since: holds accumulate, and one with no way
 * to undo it from where it can be seen is a trap rather than a feature.
 *
 * Three faces. Paused on its own: the play mark and the count behind it, and pressing lets go.
 * Paused with a branch above it: the pause mark in the held colour, outlined, saying which branch —
 * and pressing takes a hold of its own, so the pane stays paused when that branch is let go. Not
 * paused: the pause mark.
 *
 * Nothing is drawn over a filter no row selects: there is no run to hold, and a dead control reads
 * as something broken rather than as something waiting.
 */
export function HoldButton({ over, broker = 'Everything' }: { over?: string; broker?: string } = {}) {
  const { can, state, arrived, covering, toggle } = useHoldControl(over);

  if (!can) return null;

  if (state === 'covered' && covering !== null) {
    const name = holdName(covering, broker);

    return (
      <button
        type="button"
        className={styles.hold}
        data-covered=""
        aria-pressed={false}
        aria-label="Pause the pane on its own"
        title={`Paused with ${name} — pause it on its own to keep it paused when ${name} is let go`}
        onClick={toggle}
      >
        <Pause />
      </button>
    );
  }

  const held = state === 'own';
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
            ? `Paused — ${arrived} behind it`
            : 'Paused — click to catch up'
          : 'Pause the pane — traffic carries on behind it'
      }
      onClick={toggle}
    >
      {held ? <Play /> : <Pause />}
      {/* A count of nothing is not news. */}
      {waiting && <span>{arrived}</span>}
    </button>
  );
}
