import { useMutation, useQueryClient } from '@tanstack/react-query';
import { connect, disconnect } from '../../api/connection';
import { queryKeys } from '../../api/queryKeys';
import { subscribe } from '../../api/subscriptions';
import { describeError } from '../../lib/problemDetails';
import { useLogStore } from '../../stores/logStore';
import { useTopicTreeStore } from '../../stores/topicTreeStore';
import type { ConnectRequest } from '../../types/api';

export function useConnectionActions() {
  const queryClient = useQueryClient();

  const connectMutation = useMutation({
    // Only the connection itself decides whether this succeeded. Auto-subscribing is a
    // convenience layered on top: if it fails the broker is still connected, and saying
    // otherwise would be a lie the previous console never told.
    mutationFn: ({ request }: { request: ConnectRequest; autoSubscribe: boolean }) => connect(request),

    onSuccess: async (result, { request, autoSubscribe }) => {
      // Refetched rather than written from the response: the hub may already have pushed a
      // newer state — a broker that drops the session on connect — and writing the
      // response over it would replace the truth with a stale success.
      void queryClient.invalidateQueries({ queryKey: queryKeys.connection });

      // Same settings as the live session: the API left it alone, so the console does too.
      if (result.alreadyConnected) {
        useLogStore.getState().push({
          kind: 'ok',
          verb: 'Already connected',
          body: `${request.host}:${request.port} · ${request.clientId}`,
        });
        return;
      }

      // A new connection means a new tree; retained messages refill it right away.
      useTopicTreeStore.getState().reset();
      useLogStore.getState().push({
        kind: 'ok',
        verb: 'Connected',
        body: `${request.host}:${request.port} · ${request.clientId}`,
      });

      if (autoSubscribe) await subscribeToEverything();

      void queryClient.invalidateQueries({ queryKey: queryKeys.subscriptions });
      void queryClient.invalidateQueries({ queryKey: queryKeys.savedSettings });
    },

    onError: (error) =>
      useLogStore.getState().push({ kind: 'fault', verb: 'Connect failed', body: describeError(error) }),
  });

  const disconnectMutation = useMutation({
    mutationFn: disconnect,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.connection });
      void queryClient.invalidateQueries({ queryKey: queryKeys.subscriptions });
      useLogStore.getState().push({ kind: 'ok', verb: 'Disconnected' });
    },
    onError: (error) =>
      useLogStore.getState().push({ kind: 'fault', verb: 'Disconnect failed', body: describeError(error) }),
  });

  return { connectMutation, disconnectMutation };
}

// The '#' subscription the connect form offers. Reported on its own line, so a failure
// here reads as a failed subscription rather than a failed connection.
async function subscribeToEverything() {
  try {
    await subscribe({ topicFilter: '#', qos: 0 });
    useLogStore.getState().push({ kind: 'ok', verb: 'Subscribed', topic: '#', stamps: ['QoS 0'] });
  } catch (error) {
    useLogStore
      .getState()
      .push({ kind: 'fault', verb: 'Subscribe failed', topic: '#', body: describeError(error) });
  }
}

