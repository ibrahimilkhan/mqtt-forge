import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { queryKeys } from '../api/queryKeys';
import { createFrameBuffer } from '../lib/frameBuffer';
import { useHubStatusStore } from '../stores/hubStatusStore';
import { useLogStore } from '../stores/logStore';
import { useTopicTreeStore } from '../stores/topicTreeStore';
import type { MqttMessage } from '../types/api';
import { decodeIncoming } from './decodeIncoming';
import type { Hub } from './hub';

// Where hub events meet application state; mounted once, from App.
export function useHubBridge(hub: Hub) {
  const queryClient = useQueryClient();

  useEffect(() => {
    const buffer = createFrameBuffer<MqttMessage>((batch) => {
      const decoded = batch.map(decodeIncoming);
      useLogStore.getState().appendReceived(decoded);
      useTopicTreeStore.getState().apply(decoded);
    });

    const unsubscribe = hub.subscribe({
      messagesReceived: (messages) => buffer.pushAll(messages),
      connectionStateChanged: (payload) => queryClient.setQueryData(queryKeys.connection, payload),
      reconnecting: () => useHubStatusStore.getState().setStatus('reconnecting'),
      // Broker state may have moved on while the hub was down; refetch, don't trust the cache.
      reconnected: () => {
        useHubStatusStore.getState().setStatus('live');
        void queryClient.invalidateQueries();
      },
    });

    // Hub keeps retrying on its own; this just quiets the unhandled rejection and sets status.
    hub.start().catch(() => useHubStatusStore.getState().setStatus('reconnecting'));

    return () => {
      unsubscribe();
      buffer.cancel();
    };
  }, [hub, queryClient]);
}
