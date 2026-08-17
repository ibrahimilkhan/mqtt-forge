import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { queryKeys } from '../../api/queryKeys';
import { getSubscriptions, subscribe, subscribeBatch, unsubscribe } from '../../api/subscriptions';
import { PanelShell } from '../../components/PanelShell';
import { QosSelect } from '../../components/QosSelect';
import styles from '../../styles/panel.module.css';
import { logFault, useLogStore } from '../../stores/logStore';
import { useConnectionState } from '../../api/useConnectionState';
import { useTopicTreeStore } from '../../stores/topicTreeStore';
import { useGuardedKeyedMutate, useGuardedMutate } from '../../lib/useGuardedMutate';
import { FilterChips } from './FilterChips';
import { chunkFilters, parseFilters } from './parseFilters';

export function SubscribePanel({ onClose }: { onClose: () => void }) {
  const [topicFilter, setTopicFilter] = useState('sensors/#');
  const [qos, setQos] = useState(0);

  const queryClient = useQueryClient();
  const refreshFilters = () => queryClient.invalidateQueries({ queryKey: queryKeys.subscriptions });

  const { data: filters } = useQuery({ queryKey: queryKeys.subscriptions, queryFn: getSubscriptions });
  const { isOnline } = useConnectionState();

  const wanted = parseFilters(topicFilter);

  // Subscribing again to a filter that is already up is a no-op at the broker, but it still
  // costs a round trip and logs a subscription that never changed — so the live ones are
  // dropped here, and a box holding nothing else leaves the button dead.
  const active = new Set(filters ?? []);
  const fresh = wanted.filter((filter) => !active.has(filter));
  const alreadyUp = wanted.length - fresh.length;

  const subscribeMutation = useMutation({
    mutationFn: async () => {
      const filters = fresh.map((f) => ({ topicFilter: f, qos }));
      if (filters.length === 0) return;

      // A lone filter keeps the plain endpoint, so its errors stay about that one filter.
      if (filters.length === 1) return subscribe(filters[0]);

      // Serial on purpose: the packets share one MQTT connection, and a broker that refuses
      // one batch should not have several more already in flight behind it.
      for (const chunk of chunkFilters(filters)) await subscribeBatch(chunk);
    },
    onSuccess: () => {
      useLogStore.getState().push({
        kind: 'ok',
        verb: 'Subscribed',
        topic: fresh.length === 1 ? fresh[0] : `${fresh.length} filters`,
        stamps: [`QoS ${qos}`],
      });
      void refreshFilters();
    },
    onError: (error) =>
      logFault('Subscribe failed', error, fresh.length === 1 ? fresh[0] : `${fresh.length} filters`),
  });

  const unsubscribeMutation = useMutation({
    mutationFn: unsubscribe,
    onSuccess: (_result, filter) => {
      useLogStore.getState().push({ kind: 'ok', verb: 'Unsubscribed', topic: filter });
      // Read off the list this panel is showing, minus the chip that just went: the refetch
      // below has not landed yet, and the tree should not wait a round trip to stop showing
      // topics nothing is listening to any more.
      useTopicTreeStore.getState().dropFilter(filter, (filters ?? []).filter((f) => f !== filter));
      void refreshFilters();
    },
    onError: (error, filter) => logFault('Unsubscribe failed', error, filter),
  });

  const guardedSubscribe = useGuardedMutate(subscribeMutation);
  const guardedUnsubscribe = useGuardedKeyedMutate(unsubscribeMutation);

  return (
    <PanelShell title="Filters" onClose={onClose}>
      <div className={styles.row}>
        {/* The panel is about nothing else, so the box goes unlabelled on screen and carries
            its name for screen readers only.
            Takes a list as readily as one: newline or comma separated, sent as batched
            SUBSCRIBE packets so hundreds cost a couple of round trips rather than hundreds. */}
        <textarea
          id="filter"
          className={styles.filterInput}
          aria-label="Topic filter"
          rows={2}
          spellCheck={false}
          value={topicFilter}
          onChange={(e) => setTopicFilter(e.target.value)}
        />
      </div>

      <div className={styles.checks}>
        <QosSelect name="subqos" value={qos} onChange={setQos} />
      </div>

      <div className={styles.actions}>
        <button
          type="button"
          onClick={() => guardedSubscribe()}
          disabled={!isOnline || subscribeMutation.isPending || fresh.length === 0}
        >
          {fresh.length > 1 ? `Subscribe to ${fresh.length}` : 'Subscribe'}
        </button>
      </div>

      {/* Says why the button went dead, or why fewer go out than were typed — otherwise the
          count silently disagreeing with the box reads as a bug. */}
      {alreadyUp > 0 && (
        <p className={styles.note}>
          {fresh.length === 0
            ? alreadyUp === 1
              ? 'Already subscribed to that filter.'
              : 'Already subscribed to all of these.'
            : `${alreadyUp} already subscribed — only the rest will be sent.`}
        </p>
      )}

      <FilterChips
        filters={filters ?? []}
        onRemove={guardedUnsubscribe}
        pendingFilter={unsubscribeMutation.isPending ? unsubscribeMutation.variables : undefined}
      />
    </PanelShell>
  );
}
