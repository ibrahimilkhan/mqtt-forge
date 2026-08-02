import { useRef } from 'react';
import type { UseMutationResult } from '@tanstack/react-query';

// isPending updates async (batched to a microtask), so same-tick clicks both see it as
// false; a synchronously-checked ref closes that gap.
export function useGuardedMutate<TData, TError, TVariables, TContext>(
  mutation: UseMutationResult<TData, TError, TVariables, TContext>,
) {
  const inFlight = useRef(false);

  return (variables: TVariables) => {
    if (inFlight.current) return;
    inFlight.current = true;
    mutation.mutate(variables, {
      onSettled: () => {
        inFlight.current = false;
      },
    });
  };
}

// Same guard, but keyed so concurrent calls for different keys don't block each other.
export function useGuardedKeyedMutate<TData, TError, TKey extends string, TContext>(
  mutation: UseMutationResult<TData, TError, TKey, TContext>,
) {
  const inFlight = useRef(new Set<string>());

  return (key: TKey) => {
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    mutation.mutate(key, {
      onSettled: () => {
        inFlight.current.delete(key);
      },
    });
  };
}
