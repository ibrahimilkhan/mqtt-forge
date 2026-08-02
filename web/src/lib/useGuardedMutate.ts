import { useRef } from 'react';
import type { UseMutationResult } from '@tanstack/react-query';

// useMutation's isPending flips asynchronously - TanStack Query batches its listener
// notifications onto a microtask, so two clicks fired in the same tick (no yield between
// them) both see isPending: false and both call mutate(). A ref checked synchronously in
// the click handler closes that gap regardless of when React gets around to re-rendering.
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

// Same idea, but keyed - unsubscribing filter A must not block unsubscribing filter B at
// the same time, only a second click on the same chip while its own call is in flight.
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
