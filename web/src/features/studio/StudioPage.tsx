import { useCallback, useRef } from 'react';
import panel from '../../styles/panel.module.css';
import type { StudioEngine } from './engine/StudioEngine';
import type { PrimitiveType } from './model/document';
import { useStudioLayout } from './layoutStore';
import { studioStore, useStudio } from './studioStore';
import { Inspector } from './ui/Inspector';
import { Outliner } from './ui/Outliner';
import { SceneMenu } from './ui/SceneMenu';
import { Toolbar } from './ui/Toolbar';
import { Viewport } from './ui/Viewport';
import { useAutosave } from './useAutosave';
import { useStudioScene } from './useStudioScene';
import { useStudioShortcuts } from './useStudioShortcuts';
import styles from './StudioPage.module.css';

/**
 * The studio: one row of tools along the top, and under it the 3D view taking all the room there
 * is. The object tree and the inspector float over the view's left and right edges, each opened
 * and shut from the toolbar, so neither ever narrows the scene; the inspector is drawn only while
 * something is selected. Its own chunk — Babylon comes with it, and only when the panel opens.
 */
export default function StudioPage() {
  const { phase, error } = useStudioScene();
  const save = useAutosave();
  const engine = useRef<StudioEngine | null>(null);
  const onReady = useCallback((made: StudioEngine | null) => {
    engine.current = made;
  }, []);
  const focus = useCallback(() => engine.current?.focusSelection(), []);
  const onKeyDown = useStudioShortcuts({ focus });
  const treeOpen = useStudioLayout((s) => s.treeOpen);
  const inspectorOpen = useStudioLayout((s) => s.inspectorOpen);
  const selected = useStudio((s) => s.selection.length > 0);

  // Where the camera looks when there is a view; the origin when there is none to ask.
  const add = (type: PrimitiveType) => studioStore.getState().addPrimitive(type, engine.current?.viewCentre() ?? [0, 0, 0]);

  // Only when there is no scene at all to show; a scene that could not be opened is said inside
  // the studio, above the one opened in its place, so the reader can still switch or start anew.
  if (phase === 'failed') return <p className={panel.fault}>{error}</p>;
  if (phase === 'loading') return <p className={panel.note}>Opening the scene…</p>;

  return (
    <div className={styles.page} tabIndex={-1} onKeyDown={onKeyDown}>
      <Toolbar
        onAdd={add}
        onFocus={focus}
        saveState={save.state}
        onRetry={save.retry}
        sceneMenu={<SceneMenu flush={save.flush} settle={save.settle} />}
      />
      {error && <p className={panel.fault} role="alert">{error}</p>}
      <div className={styles.stage}>
        <Viewport onReady={onReady} />
        {treeOpen && (
          <div className={styles.tree}>
            <Outliner />
          </div>
        )}
        {inspectorOpen && selected && (
          <div className={styles.inspector}>
            <Inspector />
          </div>
        )}
      </div>
    </div>
  );
}
