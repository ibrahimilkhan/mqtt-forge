import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { getColourRules } from '../api/colourRules';
import { queryKeys } from '../api/queryKeys';
import { createRuleLookup, rulesFor } from './topicColour';
import { useLinkScope } from './useLinkScope';

// One array for 'no link yet', so the memo below is not undone by a fresh empty one each render.
const NONE: readonly string[] = [];

/**
 * The colour rule covering a topic, for the panes that draw one row per topic.
 *
 * The lookup is rebuilt only when the rule list itself changes, so the sort and every answer it
 * has already worked out survive the renders that messages cause — which is most of them.
 */
export function useRuleLookup() {
  const { data } = useQuery({ queryKey: queryKeys.colourRules, queryFn: getColourRules });
  // Only the rules that belong to the broker up now, and the ones for every broker.
  const keys = useLinkScope()?.keys ?? NONE;

  return useMemo(() => createRuleLookup(rulesFor(data ?? [], keys)), [data, keys]);
}
