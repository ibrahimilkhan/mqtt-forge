import type { ConnectionState } from '../types/api';
import styles from './StatusReadout.module.css';

type Props = { state: ConnectionState; reconnecting?: boolean };

// Just the state. The address it is connected to belongs to the broker panel, which has room
// to say it properly; repeating it here only made the one word that matters harder to find.
export function StatusReadout({ state, reconnecting = false }: Props) {
  // Reconnecting outranks broker state: until the hub is back, that state is stale.
  const label = reconnecting ? 'RECONNECTING' : state.toUpperCase();

  return (
    <div className={styles.readout} data-state={reconnecting ? 'Reconnecting' : state}>
      <span className={styles.lamp} />
      <span>{label}</span>
    </div>
  );
}
