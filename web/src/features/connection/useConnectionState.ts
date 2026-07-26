import { useQuery } from '@tanstack/react-query';
import { getConnectionState, getSavedSettings } from '../../api/connection';
import { queryKeys } from '../../api/queryKeys';
import type { ConnectionState } from '../../types/api';

// One place to ask what the connection is doing, so panels do not each own a query.
export function useConnectionState() {
  const { data } = useQuery({ queryKey: queryKeys.connection, queryFn: getConnectionState });
  const state: ConnectionState = data?.state ?? 'Disconnected';

  return { state, isOnline: state === 'Connected' };
}

// The address comes from the settings the API saved on the last successful connect, so no
// component has to hold on to what was typed into the form.
export function useBrokerAddress(): string | undefined {
  const { isOnline } = useConnectionState();
  const { data: saved } = useQuery({ queryKey: queryKeys.savedSettings, queryFn: getSavedSettings });

  return isOnline && saved ? `${saved.host}:${saved.port}` : undefined;
}
