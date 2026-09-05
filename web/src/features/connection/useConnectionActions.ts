import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { cancelConnect, connect, disconnect } from '../../api/connection';
import { queryKeys } from '../../api/queryKeys';
import { subscribe } from '../../api/subscriptions';
import { describeError } from '../../lib/problemDetails';
import { logFault, useLogStore } from '../../stores/logStore';
import { useTopicTreeStore } from '../../stores/topicTreeStore';
import type { ConnectRequest, ConnectionStateResponse } from '../../types/api';
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

  const connectMutation = useMutation({
    // Success means the connection itself succeeded; auto-subscribe failure doesn't count against it.
    mutationFn: async ({ request }: ConnectVars) => {
      const result = await connect(request);
      ours.current = result.dial;
      return result;
    },

    onSuccess: async (result, { request, autoSubscribe, includeSystem }) => {
      ours.current = undefined;
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

      if (autoSubscribe) await subscribeOnConnect(includeSystem, queryClient);

      void queryClient.invalidateQueries({ queryKey: queryKeys.subscriptions });
      void queryClient.invalidateQueries({ queryKey: queryKeys.savedSettings });
    },

    // An attempt the user called off is not a failure, and there is nothing to explain: they
    // know why it stopped. Reported here rather than by the abort itself, because this is the
    // request that actually ended.
    onError: (error) => {
      ours.current = undefined;

      useLogStore
        .getState()
        .push(
          wasAborted(error)
            ? { kind: 'ok', verb: 'Connect aborted' }
            : { kind: 'fault', verb: 'Connect failed', body: describeError(error) },
        );
    },
  });

  // The dial this console started, so its Abort calls off that one rather than another console's.
  // Cleared when the attempt is over, so a later Abort — from a tab that found a dial already
  // running and has no number for it — still means 'whatever is running'.
  const ours = useRef<number | undefined>(undefined);

  const abortMutation = useMutation({
    mutationFn: () => cancelConnect(ours.current),
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
 * What to listen to the moment the link is up.
 *
 * Everything, and then $SYS if it was asked for. A good many brokers out on the internet refuse a
 * bare '#' — mqtt.hsl.fi by closing the session — and either way of refusing is reported where it
 * happens: a closed session is a fault on the link, and a refused SUBACK is a line in the log.
 *
 * There used to be a third thing here: a flag that held the panel open over a link that was up
 * and listening to nothing, and offered the Filters panel as the way out. It is gone. The refusal
 * is a command that failed, and the log is where commands that failed are read.
 */
async function subscribeOnConnect(includeSystem: boolean, queryClient: QueryClient): Promise<void> {
  await ask(EVERYTHING);

  // After the one that matters. A broker that refuses this one — EMQX answers NotAuthorized —
  // says so in the SUBACK, and ask logs it. The quieter case is the one watched for: HiveMQ CE
  // grants the filter and has no $SYS tree to publish under it, so the log said 'Subscribed' and
  // nothing ever arrived, and nothing said which of the two was the odd one.
  if (includeSystem && (await ask(SYSTEM))) watchForSystem(queryClient);
}

/**
 * How long a granted $SYS subscription is given to produce something before the log says it did
 * not. Mosquitto republishes the tree every ten seconds by default and sends the retained half
 * at once; twice that is long enough to be sure of, and short enough to still read as being
 * about the connect it follows.
 */
export const SYSTEM_QUIET_AFTER = 20_000;

/**
 * Says so in the log if $SYS was granted and nothing came of it.
 *
 * A broker with no $SYS tree grants the filter like any other, and the only trace used to be a
 * subscription listed in Filters with nothing under it: a ticked box and no data, and nothing to
 * say which of the two was wrong. This is that line. It is a timer rather than a hub event
 * because the thing it reports is an absence, and it is exported because a test wants a shorter
 * wait than a reader does.
 *
 * Three reasons to say nothing, and each is a reason the line would be about a link that is not
 * this one any more: the tree started again (a new connection), the link is not up, or something
 * under $SYS did arrive after all.
 */
export function watchForSystem(queryClient: QueryClient, after = SYSTEM_QUIET_AFTER) {
  const generation = useTopicTreeStore.getState().generation;

  setTimeout(() => {
    const tree = useTopicTreeStore.getState();
    if (tree.generation !== generation) return;
    if (tree.root.children.has('$SYS')) return;

    const link = queryClient.getQueryData<ConnectionStateResponse>(queryKeys.connection);
    if (link?.state !== 'Connected') return;

    useLogStore.getState().push({
      kind: 'fault',
      verb: 'No $SYS statistics',
      topic: SYSTEM,
      body:
        `Nothing arrived under $SYS/ in ${Math.round(after / 1000)}s. The broker took the ` +
        'subscription but does not publish its statistics — HiveMQ CE has no $SYS tree; ' +
        'Mosquitto and EMQX have one.',
    });
  }, after);
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

