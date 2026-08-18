import type { ConnectionState } from '../types/api';
import styles from './StatusReadout.module.css';

type Props = {
  state: ConnectionState;
  reconnecting?: boolean;
  /** The rail is shut: the lamp alone, which is all the chip is read for at a glance anyway. */
  compact?: boolean;
};

// Just the state. The address it is connected to belongs to the broker panel, which has room
// to say it properly; repeating it here only made the one word that matters harder to find.
export function StatusReadout({ state, reconnecting = false, compact = false }: Props) {
  // Reconnecting outranks broker state: until the hub is back, that state is stale.
  const label = reconnecting ? 'RECONNECTING' : state.toUpperCase();

  return (
    <div
      className={styles.readout}
      data-state={reconnecting ? 'Reconnecting' : state}
      data-compact={compact ? '' : undefined}
      // Shut, the word is gone from the page, so the chip has to carry it itself — otherwise the
      // only reading of the link's state is a colour, which is no reading at all for some.
      title={compact ? label : undefined}
      aria-label={compact ? label : undefined}
    >
      <span className={styles.lamp} />
      {!compact && <span>{label}</span>}
    </div>
  );
}
