import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { queryKeys } from '../../api/queryKeys';
import { getSubscriptions, subscribe, unsubscribe } from '../../api/subscriptions';
import { Field } from '../../components/Field';
import { PanelShell } from '../../components/PanelShell';
import { QosSelect } from '../../components/QosSelect';
import styles from '../../styles/panel.module.css';
import { useLogStore } from '../../stores/logStore';
import { describeError } from '../connection/useConnectionActions';
import { useConnectionState } from '../connection/useConnectionState';
import { FilterChips } from './FilterChips';

export function SubscribePanel({ onClose }: { onClose: () => void }) {
  const [topicFilter, setTopicFilter] = useState('sensors/#');
  const [qos, setQos] = useState(0);

  const queryClient = useQueryClient();
  const refreshFilters = () => queryClient.invalidateQueries({ queryKey: queryKeys.subscriptions });

  const { data: filters } = useQuery({ queryKey: queryKeys.subscriptions, queryFn: getSubscriptions });
  const { isOnline } = useConnectionState();

  const subscribeMutation = useMutation({
    mutationFn: () => subscribe({ topicFilter, qos }),
    onSuccess: () => {
      useLogStore
        .getState()
        .push({ kind: 'ok', verb: 'Subscribed', topic: topicFilter, stamps: [`QoS ${qos}`] });
      void refreshFilters();
    },
    onError: (error) =>
      useLogStore
        .getState()
        .push({ kind: 'fault', verb: 'Subscribe failed', topic: topicFilter, body: describeError(error) }),
  });

  const unsubscribeMutation = useMutation({
    mutationFn: unsubscribe,
    onSuccess: (_result, filter) => {
      useLogStore.getState().push({ kind: 'ok', verb: 'Unsubscribed', topic: filter });
      void refreshFilters();
    },
    onError: (error, filter) =>
      useLogStore
        .getState()
        .push({ kind: 'fault', verb: 'Unsubscribe failed', topic: filter, body: describeError(error) }),
  });

  return (
    <PanelShell title="Subscribe" onClose={onClose}>
      <div className={styles.row}>
        <Field label="Topic filter" htmlFor="filter">
          <input
            id="filter"
            type="text"
            value={topicFilter}
            onChange={(e) => setTopicFilter(e.target.value)}
          />
        </Field>
      </div>

      <div className={styles.checks}>
        <QosSelect name="subqos" value={qos} onChange={setQos} />
      </div>

      <div className={styles.actions}>
        <button type="button" onClick={() => subscribeMutation.mutate()} disabled={!isOnline}>
          Subscribe
        </button>
      </div>

      <FilterChips filters={filters ?? []} onRemove={(filter) => unsubscribeMutation.mutate(filter)} />
    </PanelShell>
  );
}
