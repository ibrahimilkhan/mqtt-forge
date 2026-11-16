import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ChangeEvent } from 'react';
import { deleteScene, listScenes, uploadModel } from '../../../api/studio';
import { queryKeys } from '../../../api/queryKeys';
import { blankScene } from '../model/defaults';
import { newId } from '../model/ids';
import { readSceneFile, SceneFileError, uploadPending } from '../model/sceneFile';
import { studioStore, useStudio } from '../studioStore';
import type { Autosave } from '../useAutosave';
import { openScene, UNTITLED } from '../useStudioScene';
import styles from './SceneMenu.module.css';

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Which scene is open, and the things done to scenes as a whole. Every switch writes the current
 * scene first (`flush`), so moving away never loses the last half second of work — and if that
 * write fails, the switch does not happen and the menu says why. Deleting the open scene waits out
 * its autosave instead (`settle`), so no late write can bring it back.
 */
export function SceneMenu({ flush, settle }: Pick<Autosave, 'flush' | 'settle'>) {
  const queryClient = useQueryClient();
  const scenes = useQuery({ queryKey: queryKeys.studioScenes, queryFn: listScenes });
  const scene = useStudio((s) => s.scene);
  const [mode, setMode] = useState<'idle' | 'renaming' | 'deleting' | 'importing'>('idle');
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  if (!scene) return null;

  const listed = scenes.data ?? [];
  // A scene not saved yet, or the list not read yet, still has to be the one the picker shows.
  const options = listed.some((s) => s.id === scene.id)
    ? listed
    : [{ id: scene.id, name: scene.name, updatedAt: scene.updatedAt }, ...listed];

  const run = async (work: () => Promise<void>) => {
    setProblem(null);
    try {
      await work();
    } catch (error) {
      setProblem(messageOf(error));
    }
  };

  const switchTo = (id: string) => run(async () => {
    await flush();
    await openScene(id);
  });

  const startNew = () => run(async () => {
    await flush();
    studioStore.getState().open(blankScene(UNTITLED), false);
  });

  const duplicate = () => run(async () => {
    await flush();
    studioStore.getState().open({ ...scene, id: newId(), name: `${scene.name} copy` }, false);
  });

  const remove = () => run(async () => {
    // Nothing in it is worth writing any more: marked saved, no change schedules another write,
    // and the one that may already be on its way is let finish before the delete goes.
    const { revision, savedRevision } = studioStore.getState();
    studioStore.getState().markSaved(revision);
    const resume = await settle(scene.id);
    try {
      await deleteScene(scene.id);
    } catch (error) {
      // The scene stays, so its edits are as unsaved as they were before the delete was asked
      // for: put that back, and the autosave writes them as it would have.
      resume();
      studioStore.getState().markSaved(savedRevision);
      throw error;
    }
    setMode('idle');
    const rest = listed.filter((s) => s.id !== scene.id);
    await queryClient.invalidateQueries({ queryKey: queryKeys.studioScenes });
    if (rest[0]) await openScene(rest[0].id);
    else studioStore.getState().open(blankScene(UNTITLED), false);
  });

  const rename = () => {
    studioStore.getState().renameScene(name);
    setMode('idle');
  };

  const importFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || mode === 'importing') return;
    setMode('importing');
    void run(async () => {
      // Read before the parse: a file that cannot be read is not one that is not JSON.
      const text = await file.text();
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new SceneFileError('This file is not JSON, so it is not a scene.');
      }
      const read = readSceneFile(raw, { id: newId(), name: file.name.replace(/\.json$/i, '') || UNTITLED });
      const imported = await uploadPending(read.scene, read.pending, uploadModel);
      await flush();
      studioStore.getState().open(imported, false);
    }).finally(() => setMode('idle'));
  };

  return (
    <div className={styles.menu}>
      {mode === 'renaming' ? (
        <input
          type="text"
          aria-label="Scene name"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') rename();
            if (e.key === 'Escape') setMode('idle');
          }}
          onBlur={rename}
        />
      ) : (
        <label className={styles.pick}>
          <span className={styles.label}>Scene</span>
          <select aria-label="Scene" value={scene.id} onChange={(e) => void switchTo(e.target.value)}>
            {options.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id === scene.id ? scene.name : s.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <button type="button" onClick={() => void startNew()} aria-label="New scene">
        New
      </button>
      <button type="button" onClick={() => { setName(scene.name); setMode('renaming'); }}>
        Rename
      </button>
      <button type="button" onClick={() => void duplicate()}>
        Duplicate
      </button>
      {mode === 'deleting' ? (
        <span className={styles.confirm}>
          <button type="button" className="ends" onClick={() => void remove()}>
            Delete {scene.name}
          </button>
          <button type="button" onClick={() => setMode('idle')}>
            Keep
          </button>
        </span>
      ) : (
        <button type="button" className="ends" onClick={() => setMode('deleting')}>
          Delete
        </button>
      )}
      <label className={styles.import}>
        <span>{mode === 'importing' ? 'Importing…' : 'Import DesignBox scene…'}</span>
        <input
          type="file"
          accept=".json,application/json"
          aria-label="Import a DesignBox scene"
          disabled={mode === 'importing'}
          onChange={importFile}
        />
      </label>
      {problem && <p className={styles.problem} role="alert">{problem}</p>}
    </div>
  );
}
