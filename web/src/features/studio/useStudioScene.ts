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

/**
 * Whatever the studio should be showing when it opens: the scene already in the store if the panel
 * was closed and opened again, else the most recently saved one, else a new one — saved straight
 * away, so a first visit leaves a scene behind rather than an empty list.
 */
export function useStudioScene(): { phase: 'loading' | 'ready' | 'failed'; error: string | null } {
  const scenes = useQuery({ queryKey: queryKeys.studioScenes, queryFn: listScenes });
  const open = useStudio((s) => s.scene !== null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open || !scenes.data) return;
    const newest = [...scenes.data].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (newest) openScene(newest.id).catch((e: unknown) => setError(`The scene "${newest.name}" could not be opened: ${e instanceof Error ? e.message : String(e)}`));
    else studioStore.getState().open(blankScene(UNTITLED), false);
  }, [open, scenes.data]);

  if (scenes.error) return { phase: 'failed', error: `The scene list could not be read: ${scenes.error.message}` };
  if (error) return { phase: 'failed', error };
  return { phase: open ? 'ready' : 'loading', error: null };
}
