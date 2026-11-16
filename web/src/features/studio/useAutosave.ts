import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { putScene } from '../../api/studio';
import { queryKeys } from '../../api/queryKeys';
import { isDirty, studioStore } from './studioStore';
import type { SaveState } from './ui/Toolbar';

/** A pause this long after the last change is when the scene is written. */
export const SAVE_DEBOUNCE_MS = 500;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export type Autosave = {
  state: SaveState;
  /** Tries a failed save again; how it went shows in `state`. */
  retry: () => void;
  /** Writes now, and rejects if the write fails — for whoever is about to open a different scene. */
  flush: () => Promise<void>;
  /**
   * Writes nothing more of scene `id`, and waits for a write already on its way — for deleting it.
   * Resolves with `resume`, which lets that scene be written again if the delete does not happen.
   */
  settle: (id: string) => Promise<() => void>;
};

/**
 * Writes the open scene to the server a moment after it stops changing. A failed write keeps the
 * scene dirty and says so — it is never dropped — and `retry` or the next change tries again.
 * Only one write is ever on its way, so they cannot arrive out of order.
 */
export function useAutosave(): Autosave {
  const queryClient = useQueryClient();
  const [state, setState] = useState<SaveState>({ kind: 'saved' });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Never rejects: it only says when the write on its way is over, however it went.
  const inFlight = useRef<Promise<void> | null>(null);
  // Scenes on their way to being deleted: an edit made meanwhile must not write one back.
  const deleting = useRef(new Set<string>());

  const stopTimer = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const save = useCallback(async () => {
    stopTimer();
    // Every caller that found a write on its way looks again once it is over, rather than going
    // straight on — two callers waking from the same write would otherwise both send. The loop is
    // here and not in a helper: awaiting one would let the next caller wake before this one has
    // claimed `inFlight`.
    while (inFlight.current) await inFlight.current;

    const { scene, revision } = studioStore.getState();
    if (!scene || !isDirty(studioStore.getState()) || deleting.current.has(scene.id)) return;

    setState({ kind: 'saving' });
    const sent = putScene(scene).then(
      () => {
        // Only the revision that was sent, and never back past one marked saved since — a delete
        // marks the scene saved so that nothing writes it again, and this must not undo that.
        const now = studioStore.getState();
        if (now.scene?.id === scene.id && now.savedRevision < revision) now.markSaved(revision);
        setState(isDirty(studioStore.getState()) ? { kind: 'saving' } : { kind: 'saved' });
        void queryClient.invalidateQueries({ queryKey: queryKeys.studioScenes });
        return null;
      },
      (error: unknown) => {
        setState({ kind: 'failed', message: messageOf(error) });
        return error instanceof Error ? error : new Error(messageOf(error));
      },
    );
    inFlight.current = sent.then(() => {
      inFlight.current = null;
    });
    const failure = await sent;
    if (failure) throw failure;
  }, [queryClient, stopTimer]);

  // The timer and retry have no one waiting to be told: a failed write already shows as `failed`
  // with its reason, and stays dirty for the next change or retry.
  const saveQuietly = useCallback(() => {
    save().catch(() => undefined);
  }, [save]);

  useEffect(() => {
    const schedule = () => {
      if (!isDirty(studioStore.getState())) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(saveQuietly, SAVE_DEBOUNCE_MS);
    };
    schedule();
    const unsubscribe = studioStore.subscribe((now, before) => {
      // A failed save belongs to the scene it failed for: once another is open there is nothing
      // to retry, and the warning would only say something untrue about the new one.
      if (now.scene?.id !== before.scene?.id) setState({ kind: 'saved' });
      if (now.revision !== before.revision || now.savedRevision !== before.savedRevision) schedule();
    });
    return () => {
      unsubscribe();
      stopTimer();
    };
  }, [saveQuietly, stopTimer]);

  const settle = useCallback(async (id: string) => {
    deleting.current.add(id);
    stopTimer();
    // How that last write went is not the reader's concern: the scene is about to be deleted, so
    // a failure has nothing left to keep, and its `failed` state is the only trace it leaves.
    while (inFlight.current) await inFlight.current;
    return () => {
      deleting.current.delete(id);
    };
  }, [stopTimer]);

  return { state, retry: saveQuietly, flush: save, settle };
}
