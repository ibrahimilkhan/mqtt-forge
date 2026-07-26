import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { queryKeys } from '../api/queryKeys';
import { createFrameBuffer } from '../lib/frameBuffer';
import { useLogStore } from '../stores/logStore';
import { useTopicTreeStore } from '../stores/topicTreeStore';
import type { MqttMessage } from '../types/api';
import type { Hub } from './hub';

// The one place hub events meet application state. Mounted once, from App.
export function useHubBridge(hub: Hub) {
  const queryClient = useQueryClient();

  useEffect(() => {
    const buffer = createFrameBuffer<MqttMessage>((batch) => {
      useLogStore.getState().appendReceived(batch);
      useTopicTreeStore.getState().apply(batch);
    });

    const unsubscribe = hub.subscribe({
      messageReceived: (message) => buffer.push(message),
      connectionStateChanged: (payload) => queryClient.setQueryData(queryKeys.connection, payload),
      // While the hub was down the broker state may have moved on; refetch rather than
      // trust what is cached.
      reconnected: () => void queryClient.invalidateQueries(),
    });

    void hub.start();

    return () => {
      unsubscribe();
      buffer.cancel();
    };
  }, [hub, queryClient]);
}
