import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { getScene, listScenes } from '../../api/studio';
import { queryKeys } from '../../api/queryKeys';
import { blankScene } from './model/defaults';
import { readSceneFile } from './model/sceneFile';
import { studioStore, useStudio } from './studioStore';

export const UNTITLED = 'Untitled scene';

/** Reads a stored scene and puts it in the store. */
export async function openScene(id: string) {
  const { scene } = readSceneFile(await getScene(id), { id, name: UNTITLED });
  studioStore.getState().open(scene);
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Whatever the studio should be showing when it opens: the scene already in the store if the panel
 * was closed and opened again, else the most recently saved one, else a new one — saved straight
 * away, so a first visit leaves a scene behind rather than an empty list.
 *
 * A saved scene that cannot be opened does not take the studio with it: the next one that can be
 * read opens instead — or a new one if none can — and `error` says which could not, for as long
 * as the scene opened in its place is the one showing. Only a list that cannot be read, with
 * nothing open, leaves nothing to show.
 */
export function useStudioScene(): { phase: 'loading' | 'ready' | 'failed'; error: string | null } {
  const scenes = useQuery({ queryKey: queryKeys.studioScenes, queryFn: listScenes });
  const open = useStudio((s) => s.scene !== null);
  const openId = useStudio((s) => s.scene?.id ?? null);
  const [fault, setFault] = useState<{ error: string; sceneId: string } | null>(null);

  useEffect(() => {
    if (open || !scenes.data) return;
    // A refresh of the list while the scenes are still being tried must not start a second round.
    let stale = false;
    const newestFirst = [...scenes.data].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    void (async () => {
      const failures: string[] = [];
      let found = false;
      for (const summary of newestFirst) {
        try {
          await openScene(summary.id);
          found = true;
          break;
        } catch (e) {
          failures.push(`The scene "${summary.name}" could not be opened: ${messageOf(e)}`);
        }
        // Opening one re-runs this effect too, so `stale` only counts while nothing has opened.
        if (stale) return;
      }
      if (!found) studioStore.getState().open(blankScene(UNTITLED), false);
      const opened = studioStore.getState().scene;
      if (failures.length > 0 && opened) setFault({ error: failures.join(' '), sceneId: opened.id });
    })();
    return () => {
      stale = true;
    };
  }, [open, scenes.data]);

  // Only while there is nothing else to show: autosave refreshes the list after every write, and
  // one refresh that fails must not take an open scene away from whoever is working on it.
  if (!open && scenes.error) return { phase: 'failed', error: `The scene list could not be read: ${scenes.error.message}` };
  if (!open) return { phase: 'loading', error: null };
  return { phase: 'ready', error: fault && fault.sceneId === openId ? fault.error : null };
}
