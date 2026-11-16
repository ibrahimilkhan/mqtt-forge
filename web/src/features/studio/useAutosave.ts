import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { putScene } from '../../api/studio';
import { queryKeys } from '../../api/queryKeys';
import { isDirty, studioStore } from './studioStore';
import type { SaveState } from './ui/Toolbar';

/** A pause this long after the last change is when the scene is written. */
export const SAVE_DEBOUNCE_MS = 500;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Writes the open scene to the server a moment after it stops changing. A failed write keeps the
 * scene dirty and says so — it is never dropped — and `retry` or the next change tries again.
 * `flush` writes now, for whoever is about to put a different scene in the store.
 */
export function useAutosave(): { state: SaveState; retry: () => void; flush: () => Promise<void> } {
  const queryClient = useQueryClient();
  const [state, setState] = useState<SaveState>({ kind: 'saved' });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);

  const save = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (inFlight.current) await inFlight.current;

    const { scene, revision } = studioStore.getState();
    if (!scene || !isDirty(studioStore.getState())) return;

    setState({ kind: 'saving' });
    const attempt = putScene(scene)
      .then(() => {
        // Only the revision that was sent: a change made while it was on its way is still unsaved.
        if (studioStore.getState().scene?.id === scene.id) studioStore.getState().markSaved(revision);
        setState(isDirty(studioStore.getState()) ? { kind: 'saving' } : { kind: 'saved' });
        void queryClient.invalidateQueries({ queryKey: queryKeys.studioScenes });
      })
      .catch((error: unknown) => setState({ kind: 'failed', message: messageOf(error) }))
      .finally(() => {
        inFlight.current = null;
      });
    inFlight.current = attempt;
    await attempt;
  }, [queryClient]);

  useEffect(() => {
    const schedule = () => {
      if (!isDirty(studioStore.getState())) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void save(), SAVE_DEBOUNCE_MS);
    };
    schedule();
    const unsubscribe = studioStore.subscribe((now, before) => {
      if (now.revision !== before.revision || now.savedRevision !== before.savedRevision) schedule();
    });
    return () => {
      unsubscribe();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [save]);

  return { state, retry: () => void save(), flush: save };
}
