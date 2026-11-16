import { useCallback, useRef } from 'react';
import panel from '../../styles/panel.module.css';
import type { StudioEngine } from './engine/StudioEngine';
import type { PrimitiveType } from './model/document';
import { studioStore } from './studioStore';
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
 * The studio: toolbar along the top, objects on the left, the 3D view in the middle and the
 * inspector on the right. Its own chunk — Babylon comes with it, and only when the panel opens.
 */
export default function StudioPage() {
  const { phase, error } = useStudioScene();
  const save = useAutosave();
  const engine = useRef<StudioEngine | null>(null);
  const onReady = useCallback((made: StudioEngine | null) => {
    engine.current = made;
  }, []);
  const onKeyDown = useStudioShortcuts({ focus: () => engine.current?.focusSelection() });

  // Where the camera looks when there is a view; the origin when there is none to ask.
  const add = (type: PrimitiveType) => studioStore.getState().addPrimitive(type, engine.current?.viewCentre() ?? [0, 0, 0]);

  if (phase === 'failed') return <p className={panel.fault}>{error}</p>;
  if (phase === 'loading') return <p className={panel.note}>Opening the scene…</p>;

  return (
    <div className={styles.page} tabIndex={-1} onKeyDown={onKeyDown}>
      <Toolbar onAdd={add} saveState={save.state} onRetry={save.retry} sceneMenu={<SceneMenu flush={save.flush} settle={save.settle} />} />
      <div className={styles.body}>
        <Outliner />
        <Viewport onReady={onReady} />
        <Inspector />
      </div>
    </div>
  );
}
