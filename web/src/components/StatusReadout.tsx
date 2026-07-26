import type { ConnectionState } from '../types/api';
import styles from './StatusReadout.module.css';

type Props = { state: ConnectionState; where?: string; reconnecting?: boolean };

export function StatusReadout({ state, where, reconnecting = false }: Props) {
  // A hub that is re-establishing itself outranks the broker state: until it is back,
  // what the page shows about the broker is stale by definition.
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
