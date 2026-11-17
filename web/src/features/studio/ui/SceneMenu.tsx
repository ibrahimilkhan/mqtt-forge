import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type ChangeEvent } from 'react';
import { deleteScene, isSceneUnknown, listScenes, uploadModel } from '../../../api/studio';
import { queryKeys } from '../../../api/queryKeys';
import { blankScene } from '../model/defaults';
import { newId } from '../model/ids';
import { readSceneFile, SceneFileError, uploadPending } from '../model/sceneFile';
import { studioStore, useStudio } from '../studioStore';
import type { Autosave } from '../useAutosave';
import { openScene, UNTITLED } from '../useStudioScene';
import { CheckGlyph, ChevronDownGlyph, CopyGlyph, FolderGlyph, ImportGlyph, PencilGlyph, PlusGlyph, TrashGlyph } from './icons';
import { ToolMenu } from './ToolMenu';
import menu from './ToolMenu.module.css';
import bar from './Toolbar.module.css';
import styles from './SceneMenu.module.css';

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Which scene is open, and the things done to scenes as a whole — folded into the toolbar's first
 * dropdown, whose button carries the open scene's name: the list of scenes to switch between, and
 * under it New, Rename, Duplicate, Delete and Import, renaming and the delete's confirmation done
 * inside the popup itself.
 *
 * The work goes on whether the popup is open or not; its state lives here, beside the button, not
 * in the popup. A piece of work that succeeds shuts the popup; one that fails opens it again if the
 * reader had shut it meanwhile, since the popup is where the failure is said.
 *
 * Every switch writes the current scene first (`flush`), so moving away never loses the last half
 * second of work — and if that write fails, the switch does not happen and the menu says why.
 * Deleting the open scene waits out its autosave instead (`settle`), so no late write can bring it
 * back.
 */
export function SceneMenu({ flush, settle }: Pick<Autosave, 'flush' | 'settle'>) {
  const queryClient = useQueryClient();
  const scenes = useQuery({ queryKey: queryKeys.studioScenes, queryFn: listScenes });
  const scene = useStudio((s) => s.scene);
  const [mode, setMode] = useState<'idle' | 'renaming' | 'deleting' | 'importing'>('idle');
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  // Set while the name field is up, so the blur that follows an Enter does not rename a second time
  // and leave a second, empty step on the undo list.
  const editing = useRef(false);

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
      setOpen(false);
    } catch (error) {
      setProblem(messageOf(error));
      setOpen(true);
    }
  };

  // A reader opening the menu afresh is not still reading the last thing that went wrong in it.
  const onOpenChange = (next: boolean) => {
    if (next) setProblem(null);
    if (!next && mode !== 'importing') setMode('idle');
    setOpen(next);
  };

  const switchTo = (id: string) => run(async () => {
    if (id === scene.id) return;
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
    // Let go of the id only once another scene is open or the delete has failed: until then an
    // edit to the scene on its way out must not write it back.
    try {
      try {
        await deleteScene(scene.id);
      } catch (error) {
        // Already gone — another console deleted it — is what was asked for, not a failure: the
        // edits it would put back as unsaved would only write the scene again.
        if (!isSceneUnknown(error)) {
          // The scene stays, so its edits are as unsaved as they were before the delete was asked
          // for: put that back, and the autosave writes them as it would have.
          studioStore.getState().markSaved(savedRevision);
          throw error;
        }
      }
      setMode('idle');
      const rest = listed.filter((s) => s.id !== scene.id);
      await queryClient.invalidateQueries({ queryKey: queryKeys.studioScenes });
      try {
        if (rest[0]) await openScene(rest[0].id);
        else studioStore.getState().open(blankScene(UNTITLED), false);
      } catch (error) {
        // The deleted scene must not stay open: once `resume` lets go of its id, the next edit
        // would write it back. A new scene stands in, and the menu says which could not open.
        studioStore.getState().open(blankScene(UNTITLED), false);
        throw new Error(`The scene "${rest[0].name}" could not be opened: ${messageOf(error)}`);
      }
    } finally {
      resume();
    }
  });

  const rename = () => {
    if (!editing.current) return;
    editing.current = false;
    if (name.trim() !== scene.name) studioStore.getState().renameScene(name);
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
      // Always a new scene: a version 2 file carries its own id, and keeping it would have the
      // autosave write the import over whichever saved scene already has that id.
      studioStore.getState().open({ ...imported, id: newId() }, false);
    }).finally(() => setMode('idle'));
  };

  return (
    <ToolMenu
      kind="dialog"
      title="Scenes"
      triggerClassName={`${bar.opens} ${styles.trigger}`}
      open={open}
      onOpenChange={onOpenChange}
      trigger={
        <>
          <FolderGlyph />
          <span className={styles.name}>
            <span className="srOnly">Scene:</span> {scene.name}
          </span>
          <span className={bar.chevron}>
            <ChevronDownGlyph />
          </span>
        </>
      }
    >
      {(close) => (
        <>
          {problem && <p className={styles.problem} role="alert">{problem}</p>}

          <ul className={styles.list} aria-label="Scenes">
            {options.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className={menu.item}
                  aria-current={s.id === scene.id}
                  onClick={() => (s.id === scene.id ? close() : void switchTo(s.id))}
                >
                  {s.id === scene.id ? <CheckGlyph /> : <span className={styles.blank} />}
                  <span className={styles.label}>{s.id === scene.id ? scene.name : s.name}</span>
                </button>
              </li>
            ))}
          </ul>
          <hr className={menu.rule} />

          <button type="button" className={menu.item} onClick={() => void startNew()}>
            <PlusGlyph />
            New scene
          </button>
          {mode === 'renaming' ? (
            <input
              type="text"
              className={styles.field}
              aria-label="Scene name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  // Held here: the keyboard goes back to the scene button as the menu shuts, and
                  // an Enter let through would press that button and open the menu again.
                  e.preventDefault();
                  rename();
                  close();
                }
                // Escape leaves the name as it was and keeps the menu open; the menu's own Escape
                // is the next one.
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  editing.current = false;
                  setMode('idle');
                }
              }}
              onBlur={rename}
            />
          ) : (
            <button
              type="button"
              className={menu.item}
              onClick={() => {
                editing.current = true;
                setName(scene.name);
                setMode('renaming');
              }}
            >
              <PencilGlyph />
              Rename
            </button>
          )}
          <button type="button" className={menu.item} onClick={() => void duplicate()}>
            <CopyGlyph />
            Duplicate
          </button>
          {mode === 'deleting' ? (
            <div className={styles.confirm}>
              <button type="button" className="ends" onClick={() => void remove()}>
                Delete {scene.name}
              </button>
              <button type="button" className={menu.item} autoFocus onClick={() => setMode('idle')}>
                Keep
              </button>
            </div>
          ) : (
            <button type="button" className={`${menu.item} ends`} onClick={() => setMode('deleting')}>
              <TrashGlyph />
              Delete
            </button>
          )}
          <label className={`${menu.item} ${styles.import}`} data-busy={mode === 'importing'}>
            <ImportGlyph />
            {mode === 'importing' ? 'Importing…' : 'Import DesignBox scene…'}
            <input
              type="file"
              accept=".json,application/json"
              aria-label="Import a DesignBox scene"
              disabled={mode === 'importing'}
              onChange={importFile}
            />
          </label>
        </>
      )}
    </ToolMenu>
  );
}
