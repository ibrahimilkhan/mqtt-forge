import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { getSavedProfiles } from '../api/connection';
import { queryKeys } from '../api/queryKeys';
import { useHeldLink } from '../api/useConnectionState';
import { scopeOf, type BrokerScope } from './brokerScope';

/**
 * The broker whose rules apply, known by its saved id and by its address — see brokerScope.
 *
 * Null only before any link has come up. Until the saved brokers have been read the link answers
 * to its own id and its address, which is every rule it can name before then anyway.
 */
export function useLinkScope(): BrokerScope | null {
  const link = useHeldLink();
  const { data: profiles } = useQuery({ queryKey: queryKeys.savedProfiles, queryFn: getSavedProfiles });

  return useMemo(() => (link ? scopeOf(link, profiles) : null), [link, profiles]);
}
