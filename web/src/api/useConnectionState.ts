import { useQuery } from '@tanstack/react-query';
import type { ConnectionState } from '../types/api';
import { getConnectionState, getSavedSettings } from './connection';
import { queryKeys } from './queryKeys';

// Shared connection query so panels don't each own one; lives here since no feature owns it.
export function useConnectionState() {
  const { data } = useQuery({ queryKey: queryKeys.connection, queryFn: getConnectionState });
  const state: ConnectionState = data?.state ?? 'Disconnected';

  return { state, failure: data?.failure, isOnline: state === 'Connected' };
}

// Reads the last-saved connect settings, so no component holds onto the typed form.
export function useBrokerAddress(): string | undefined {
  const { isOnline } = useConnectionState();
  const { data: saved } = useQuery({ queryKey: queryKeys.savedSettings, queryFn: getSavedSettings });

  return isOnline && saved ? `${saved.host}:${saved.port}` : undefined;
}
