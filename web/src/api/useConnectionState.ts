import { useQuery } from '@tanstack/react-query';
import type { ConnectionState } from '../types/api';
import { getConnectionState } from './connection';
import { queryKeys } from './queryKeys';

// Shared connection query so panels don't each own one; lives here since no feature owns it.
export function useConnectionState() {
  const { data } = useQuery({ queryKey: queryKeys.connection, queryFn: getConnectionState });
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
  };
}

// The live link, not the saved settings: those record the last connect that WORKED, which is a
// different question from what is up now — and saving them is allowed to fail without failing
// the connect. The link comes from the same payload as the state, so the two cannot disagree.
export function useBrokerAddress(): string | undefined {
  const { link } = useConnectionState();

  return link ? `${link.host}:${link.port}` : undefined;
}
