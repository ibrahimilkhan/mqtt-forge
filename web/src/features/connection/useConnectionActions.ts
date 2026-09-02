import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
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

type ConnectVars = { request: ConnectRequest; autoSubscribe: boolean; includeSystem: boolean };

export function useConnectionActions() {
  const queryClient = useQueryClient();

  /**
   * Whether the broker turned down the subscription this console asks for on connect.
   *
   * Its own state because there is nothing else to carry it. A broker that refuses every topic
   * has two ways of saying so, and only one of them is a failure: it can close the session, which
   * arrives as a fault with a reason on it, or it can answer the SUBACK with a refusal code and
   * leave the link up. The second is the quiet one — the connect worked, the link is up, and the
   * console is listening to nothing at all — and until now the only trace of it was a line in the
   * log, on a panel that had already stepped aside because the link held.
   */
  const [everythingRefused, setEverythingRefused] = useState(false);

  const connectMutation = useMutation({
    // Success means the connection itself succeeded; auto-subscribe failure doesn't count against it.
    mutationFn: ({ request }: ConnectVars) => connect(request),

    // A new attempt is not answered yet, whatever the last one was told.
    onMutate: () => setEverythingRefused(false),

    onSuccess: async (result, { request, autoSubscribe, includeSystem }) => {
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

      if (autoSubscribe) setEverythingRefused(await subscribeOnConnect(includeSystem));

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
      setEverythingRefused(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.connection });
      void queryClient.invalidateQueries({ queryKey: queryKeys.subscriptions });
      useLogStore.getState().push({ kind: 'ok', verb: 'Disconnected' });
    },
    onError: (error) =>
      logFault('Disconnect failed', error),
  });

  return { connectMutation, disconnectMutation, abortMutation, everythingRefused };
}

/** Everything, which is what the box beside Connect asks for. */
const EVERYTHING = '#';

/**
 * Everything the broker says about itself, which '#' does not cover.
 *
 * Not an extra: MQTT reserves it. A topic filter beginning with a wildcard must not match a topic
 * name beginning with '$' — MQTT 5.0 §4.7.2 — so a console subscribed to '#' and nothing else is
 * blind to $SYS by the specification rather than by an oversight. Measured against Mosquitto 2:
 * '#' returned nought $SYS topics in five seconds and '$SYS/#' returned fifty-five.
 *
 * It is a second SUBSCRIBE and it is asked for separately, which is also how MQTT Explorer does
 * it. Off by default here and on by default there, and the difference is the traffic: these are
 * republished on a timer — every ten seconds on a stock Mosquitto — so a reader who did not ask
 * for them would find a subtree they never subscribed to churning through their log for as long
 * as the console was open.
 */
const SYSTEM = '$SYS/#';

/**
 * And at the highest ceiling, which is what makes the log's QoS mean anything.
 *
 * A subscription's QoS is a cap, not a demand: a broker delivers every copy at the lower of the
 * published and the subscribed level. Listening at 0 — which this did — capped every arrival at
 * 0, so the QoS stamp on a row was a constant this console had written itself, and a reader who
 * published at QoS 2 read their own message back as 'qos 0' and concluded the level had been
 * dropped. At 2 the stamp is the publisher's own answer: a QoS 0 publish still arrives at 0.
 *
 * It is not free. Every QoS 1 arrival is acknowledged and every QoS 2 arrival takes a four-packet
 * handshake, which on a firehose of QoS 2 traffic is real work — but a firehose of QoS 2 is
 * already the broker doing that work with every subscriber, and a console that cannot report the
 * level it is monitoring is not much of a monitor. A reader who wants the cheap read can add a
 * narrower filter at QoS 0 in the Filters panel.
 */
const EVERYTHING_QOS = 2;

/**
 * What to listen to the moment the link is up, and whether the broker said no.
 *
 * Everything, or nothing at all. A good many brokers out on the internet refuse a bare '#' —
 * mqtt.hsl.fi by closing the session — and that used to be guarded against with a filter box in
 * the panel. It is answered where it happens instead: the refusal is reported, and the Filters
 * panel is one button away from it.
 *
 * Reported on its own log line, so a failure here reads as a subscribe failure, not a connect
 * failure: the link is a separate thing and may well still be up. The answer is returned as well
 * as logged, because a link that is still up is exactly the case a log line on its own is not
 * enough for — see everythingRefused above.
 */
async function subscribeOnConnect(includeSystem: boolean): Promise<boolean> {
  const refused = !(await ask(EVERYTHING));

  // After the one that matters, and never allowed to answer for it. A broker with no $SYS tree at
  // all is an ordinary broker — HiveMQ CE has none — and one that has it may still refuse it to a
  // client that has not been given the right; neither is a console listening to nothing, which is
  // what everythingRefused means and what the panel offers a way out of. So this one is reported
  // in the log and forgotten.
  if (includeSystem) await ask(SYSTEM);

  return refused;
}

/** One filter, at the ceiling, and whether the broker took it. */
async function ask(topicFilter: string): Promise<boolean> {
  try {
    await subscribe({ topicFilter, qos: EVERYTHING_QOS });
    useLogStore
      .getState()
      .push({ kind: 'ok', verb: 'Subscribed', topic: topicFilter, stamps: [`QoS ${EVERYTHING_QOS}`] });

    return true;
  } catch (error) {
    logFault('Subscribe failed', error, topicFilter);

    return false;
  }
}

