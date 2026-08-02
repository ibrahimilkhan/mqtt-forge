import type { ConnectionState } from '../types/api';
import styles from './StatusReadout.module.css';

type Props = { state: ConnectionState; where?: string; reconnecting?: boolean };

export function StatusReadout({ state, where, reconnecting = false }: Props) {
  // Reconnecting outranks broker state: until the hub is back, that state is stale.
  const label = reconnecting
    ? 'RECONNECTING'
    : where
      ? `${state.toUpperCase()} · ${where}`
      : state.toUpperCase();

  return (
    <div className={styles.readout} data-state={reconnecting ? 'Reconnecting' : state}>
      <span className={styles.lamp} />
      <span>{label}</span>
    </div>
  );
}
