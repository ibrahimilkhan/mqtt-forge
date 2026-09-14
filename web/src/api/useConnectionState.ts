import { useQuery } from '@tanstack/react-query';
import type { ConnectionState, ConnectionStateResponse } from '../types/api';
import { getConnectionState } from './connection';
import { queryKeys } from './queryKeys';

/**
 * The link's state as the console holds it: the server's answer, and when the console received it.
 *
 * `seenAt` is the console's own and never comes over the wire, which is why it lives here rather
 * than on the server's contract. It is written where an answer arrives — the fetch below, and the
 * hub bridge's `connectionStateChanged` — on the clock a message is stamped with as it arrives,
 * because a link coming back is compared against those messages: a row is drawn faded when nothing
 * under it was received after the return. Absent on an answer written anywhere else.
 */
export type SeenConnectionState = ConnectionStateResponse & { seenAt?: number };

/** The server's answer, dated the moment it lands — the way the hub bridge dates one it is pushed. */
const fetchConnectionState = async (): Promise<SeenConnectionState> => ({
  ...(await getConnectionState()),
  seenAt: Date.now(),
});

// Shared connection query so panels don't each own one; lives here since no feature owns it.
export function useConnectionState() {
  const { data } = useQuery({ queryKey: queryKeys.connection, queryFn: fetchConnectionState });
  const state: ConnectionState = data?.state ?? 'Disconnected';

  // isConnecting comes off the API's own state, not a mutation, so a panel that never started
  // the attempt — one reopened after a switch — still sees it running.
  return {
    state,
    failure: data?.failure,
    link: data?.connection ?? undefined,
    isOnline: state === 'Connected',
    isConnecting: state === 'Connecting',
    // Whether the state above is the API's answer or the standing-in Disconnected. Anything
    // watching for a CHANGE of state needs it: without it the first answer looks like a change
    // from a guess, and a page reloaded over a live link reads as one that just came up.
    answered: data !== undefined,
    // When the console received the state above, on its own clock. See SeenConnectionState.
    seenAt: data?.seenAt,
  };
}

// The live link, not the saved settings: those record the last connect that WORKED, which is a
// different question from what is up now — and saving them is allowed to fail without failing
// the connect. The link comes from the same payload as the state, so the two cannot disagree.
export function useBrokerAddress(): string | undefined {
  const { link } = useConnectionState();

  return link ? `${link.host}:${link.port}` : undefined;
}
