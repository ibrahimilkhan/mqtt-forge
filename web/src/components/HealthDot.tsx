import { useQuery } from '@tanstack/react-query';
import { getHealth } from '../api/health';
import { queryKeys } from '../api/queryKeys';
import styles from './HealthDot.module.css';

const POLL_INTERVAL_MS = 15_000;

const LABEL: Record<'pending' | 'error' | 'success', string> = {
  pending: 'Checking API…',
  success: 'API healthy',
  error: 'API unreachable',
};

export function HealthDot() {
  // Keeps polling in a backgrounded tab so the reading isn't stale on return.
  const { status } = useQuery({
    queryKey: queryKeys.health,
    queryFn: getHealth,
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: true,
    retry: false,
  });

  return (
    <div className={styles.dot} data-state={status} role="status">
      <span className={styles.lamp} />
      <span>{LABEL[status]}</span>
    </div>
  );
}
