import { useConnectionState } from '../../api/useConnectionState';
import { useReconnectStatus } from '../../api/useReconnectStatus';
import { useHubStatusStore } from '../../stores/hubStatusStore';

/**
 * What the console's link is doing, in the six words the whole app says it in.
 *
 * Four states come off the API and two are read out of what else is going on, and the question
 * every one of them answers is the same: what, if anything, is being done about this.
 *
 *   Connected    — there is a link.
 *   Waiting      — a connect is in flight.
 *   Retrying     — there is no link and the ladder is climbing back to one.
 *   Faulted      — there is no link and nothing is being done about it.
 *   Reconnecting — the console has lost its own server, so it cannot say anything about the
 *                  broker at all. Everything on screen is the last thing it heard.
 *   Disconnected — nobody has asked for a link yet. The console opens here.
 *
 * It lived in App.tsx, read by the rail and nowhere else, for as long as the rail was the only
 * place the state was said. The broker panel says it too now, and a second derivation of six
 * states would be two readouts of one link free to disagree about it — which is the bug the
 * single rail lamp was introduced to end.
 */
export type LinkState =
  | 'Connected'
  | 'Waiting'
  | 'Retrying'
  | 'Faulted'
  | 'Reconnecting'
  | 'Disconnected';

export function useLinkState(): LinkState {
  const { state } = useConnectionState();
  /*
   * Only while there is no link. The ladder's own flag stays up through the moment it succeeds,
   * and a console that had just come back would have read 'Retrying' over a live connection.
   */
  const retrying = useReconnectStatus().status.active && state !== 'Connected';
  const hubStatus = useHubStatusStore((status) => status.status);

  if (hubStatus === 'reconnecting') return 'Reconnecting';

  /*
   * Ahead of Connecting, and that is the whole of what makes this state readable. A ladder puts
   * the link through Faulted → Connecting → Faulted once a rung, so a readout that took the
   * link's own state would swing between two colours for the length of an outage — which says
   * 'something keeps happening' where the truth is 'one thing is happening, still'. The
   * supervisor's own answer does not flicker, so neither does anything reading this.
   */
  if (retrying) return 'Retrying';
  if (state === 'Connecting') return 'Waiting';

  return state;
}

/**
 * Whether the link is in a state the reader is meant to do something about.
 *
 * Three tones rather than six states, because that is all any readout of this needs: the rail
 * tints a row with it and the broker panel's chip draws itself in it.
 *
 * 'none' for Disconnected is deliberate and is the oldest rule here: the console opens having
 * been asked to do nothing, and a red that is on at rest is a red nobody looks at when it
 * finally means something.
 */
export type LinkTone = 'live' | 'working' | 'fault' | 'none';

export function toneOf(state: LinkState): LinkTone {
  switch (state) {
    case 'Connected':
      return 'live';
    case 'Waiting':
    case 'Retrying':
      return 'working';
    case 'Faulted':
    case 'Reconnecting':
      return 'fault';
    case 'Disconnected':
      return 'none';
  }
}
