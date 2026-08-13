import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { getColourRules } from '../api/colourRules';
import { queryKeys } from '../api/queryKeys';
import { createColourLookup } from './topicColour';

/**
 * A topic's colour, for the panes that draw one row per topic.
 *
 * The lookup is rebuilt only when the rule list itself changes, so the sort and every answer it
 * has already worked out survive the renders that messages cause — which is most of them.
 */
export function useColourLookup(): (topic: string) => string | null {
  const { data } = useQuery({ queryKey: queryKeys.colourRules, queryFn: getColourRules });

  return useMemo(() => createColourLookup(data ?? []), [data]);
}
