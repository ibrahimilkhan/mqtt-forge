import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { getColourRules } from '../api/colourRules';
import { queryKeys } from '../api/queryKeys';
import { useLinkProfile } from '../api/useConnectionState';
import { createRuleLookup, rulesFor } from './topicColour';

/**
 * The colour rule covering a topic, for the panes that draw one row per topic.
 *
 * The lookup is rebuilt only when the rule list itself changes, so the sort and every answer it
 * has already worked out survive the renders that messages cause — which is most of them.
 */
export function useRuleLookup() {
  const { data } = useQuery({ queryKey: queryKeys.colourRules, queryFn: getColourRules });
  // Only the rules that belong to the broker up now, and the ones for every broker.
  const profileId = useLinkProfile();

  return useMemo(() => createRuleLookup(rulesFor(data ?? [], profileId)), [data, profileId]);
}
