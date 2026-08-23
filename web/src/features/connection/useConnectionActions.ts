import { useMutation, useQueryClient } from '@tanstack/react-query';
import { cancelConnect, connect, disconnect } from '../../api/connection';
import { queryKeys } from '../../api/queryKeys';
import { subscribe } from '../../api/subscriptions';
import { describeError } from '../../lib/problemDetails';
import { logFault, useLogStore } from '../../stores/logStore';
import { useTopicTreeStore } from '../../stores/topicTreeStore';
import type { ConnectRequest } from '../../types/api';
import { formatBrokerAddress } from './address';
import { wasAborted } from './connectFailure';
import { schemeOf } from './scheme';

// What the log line calls the broker. The scheme is part of the address now: two lines reading
// 'localhost:1883' would otherwise be the same line whether the second one went over a socket
// or a WebSocket, which is exactly the thing somebody reading the log is checking.
//
// Built by the same function the panel's own address goes through, for the brackets: an IPv6
// host written straight into a template makes `mqtt://::1:1883`, which is a line nobody can
// find the port in.
const endpoint = ({ transport, useTls, host, port }: ConnectRequest) =>
  `${formatBrokerAddress(schemeOf(transport ?? 'tcp', useTls), host)}:${port}`;

type ConnectVars = { request: ConnectRequest; autoSubscribe: boolean; onConnectFilter: string };

export function useConnectionActions() {
  const queryClient = useQueryClient();

  const connectMutation = useMutation({
    // Success means the connection itself succeeded; auto-subscribe failure doesn't count against it.
    mutationFn: ({ request }: ConnectVars) => connect(request),

    onSuccess: async (result, { request, autoSubscribe, onConnectFilter }) => {
      // Refetch, don't write the response: the hub may have already pushed a newer state.
      void queryClient.invalidateQueries({ queryKey: queryKeys.connection });

      // API left the settings alone, so the console does too.
      if (result.alreadyConnected) {
        useLogStore.getState().push({
          kind: 'ok',
          verb: 'Already connected',
          body: `${endpoint(request)} · ${request.clientId}`,
        });
        return;
      }

      // New connection, new tree — retained messages refill it right away.
      useTopicTreeStore.getState().reset();
      useLogStore.getState().push({
        kind: 'ok',
        verb: 'Connected',
        body: `${endpoint(request)} · ${request.clientId}`,
      });

      if (autoSubscribe) await subscribeOnConnect(onConnectFilter);

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

/**
 * What to listen to the moment the link is up.
 *
 * The filter comes from the panel rather than being fixed at '#'. Every public broker tested
 * refuses a bare '#' — mqtt.hsl.fi by closing the session, so the console used to connect and
 * fall over in the same breath — and a broker's own preset knows what it will actually answer.
 *
 * Reported on its own log line, so a failure here reads as a subscribe failure, not a connect
 * failure: the link is a separate thing and may well still be up.
 */
async function subscribeOnConnect(topicFilter: string) {
  const filter = topicFilter.trim();
  // Nothing to ask for. Not an error — a reader who emptied the box said they wanted no
  // subscription, and the Subscribe panel is right there.
  if (!filter) return;

  try {
    await subscribe({ topicFilter: filter, qos: 0 });
    useLogStore.getState().push({ kind: 'ok', verb: 'Subscribed', topic: filter, stamps: ['QoS 0'] });
  } catch (error) {
    logFault('Subscribe failed', error, filter);
  }
}

