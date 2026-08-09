import { useMutation, useQueryClient } from '@tanstack/react-query';
import { cancelConnect, connect, disconnect } from '../../api/connection';
import { queryKeys } from '../../api/queryKeys';
import { subscribe } from '../../api/subscriptions';
import { describeError } from '../../lib/problemDetails';
import { logFault, useLogStore } from '../../stores/logStore';
import { useTopicTreeStore } from '../../stores/topicTreeStore';
import type { ConnectRequest } from '../../types/api';
import { wasAborted } from './connectFailure';

export function useConnectionActions() {
  const queryClient = useQueryClient();

  const connectMutation = useMutation({
    // Success means the connection itself succeeded; auto-subscribe failure doesn't count against it.
    mutationFn: ({ request }: { request: ConnectRequest; autoSubscribe: boolean }) => connect(request),

    onSuccess: async (result, { request, autoSubscribe }) => {
      // Refetch, don't write the response: the hub may have already pushed a newer state.
      void queryClient.invalidateQueries({ queryKey: queryKeys.connection });

      // API left the settings alone, so the console does too.
      if (result.alreadyConnected) {
        useLogStore.getState().push({
          kind: 'ok',
          verb: 'Already connected',
          body: `${request.host}:${request.port} · ${request.clientId}`,
        });
        return;
      }

      // New connection, new tree — retained messages refill it right away.
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

    // An attempt the user called off is not a failure, and there is nothing to explain: they
    // know why it stopped. Reported here rather than by the abort itself, because this is the
    // request that actually ended.
    onError: (error) =>
      useLogStore
        .getState()
        .push(
          wasAborted(error)
            ? { kind: 'ok', verb: 'Connect aborted' }
            : { kind: 'fault', verb: 'Connect failed', body: describeError(error) },
        ),
  });

  const abortMutation = useMutation({
    mutationFn: cancelConnect,
    // The attempt's own 409 carries the outcome; a second line here would just repeat it.
    // Refetch anyway: with the hub down, nothing else would clear Connecting off the screen.
    onSettled: () => void queryClient.invalidateQueries({ queryKey: queryKeys.connection }),
    onError: (error) =>
      logFault('Abort failed', error),
  });

  const disconnectMutation = useMutation({
    mutationFn: disconnect,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.connection });
      void queryClient.invalidateQueries({ queryKey: queryKeys.subscriptions });
      useLogStore.getState().push({ kind: 'ok', verb: 'Disconnected' });
    },
    onError: (error) =>
      logFault('Disconnect failed', error),
  });

  return { connectMutation, disconnectMutation, abortMutation };
}

// Reported on its own log line, so a failure here reads as a subscribe failure, not a connect failure.
async function subscribeToEverything() {
  try {
    await subscribe({ topicFilter: '#', qos: 0 });
    useLogStore.getState().push({ kind: 'ok', verb: 'Subscribed', topic: '#', stamps: ['QoS 0'] });
  } catch (error) {
    logFault('Subscribe failed', error, '#');
  }
}

