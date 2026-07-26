import type { ConnectionState } from '../types/api';
import styles from './StatusReadout.module.css';

type Props = { state: ConnectionState; where?: string };

export function StatusReadout({ state, where }: Props) {
  return (
    <div className={styles.readout} data-state={state}>
      <span className={styles.lamp} />
      <span>{where ? `${state.toUpperCase()} · ${where}` : state.toUpperCase()}</span>
    </div>
  );
}
