import type { ReactNode } from 'react';
import { Segmented } from '../../../components/Segmented';
import { PRIMITIVE_LABELS, PRIMITIVE_TYPES } from '../model/defaults';
import type { PrimitiveType } from '../model/document';
import { studioStore, useStudio, type Orientation, type Tool } from '../studioStore';
import { DISPLAY_UNITS, formatLength, type DisplayUnit } from '../units/units';
import styles from './Toolbar.module.css';

export type SaveState = { kind: 'saved' } | { kind: 'saving' } | { kind: 'failed'; message: string };

const TOOLS: ReadonlyArray<{ value: Tool; label: string }> = [
  { value: 'select', label: 'Select' },
  { value: 'move', label: 'Move' },
  { value: 'rotate', label: 'Rotate' },
  { value: 'scale', label: 'Scale' },
];
const ORIENTATIONS: ReadonlyArray<{ value: Orientation; label: string }> = [
  { value: 'world', label: 'World' },
  { value: 'local', label: 'Local' },
];
/** Metres, shown in whichever unit the scene is shown in. */
const MOVE_STEPS = [0.001, 0.01, 0.1, 0.5, 1];
/** Degrees. */
const ROTATE_STEPS = [1, 5, 15, 45, 90];

type Props = {
  onAdd: (type: PrimitiveType) => void;
  saveState: SaveState;
  onRetry: () => void;
  sceneMenu: ReactNode;
};

/** Along the top of the studio: the scene, the shapes, the tool and its steps, and whether it is saved. */
export function Toolbar({ onAdd, saveState, onRetry, sceneMenu }: Props) {
  const tool = useStudio((s) => s.tool);
  const orientation = useStudio((s) => s.orientation);
  const settings = useStudio((s) => s.scene?.settings);
  const canUndo = useStudio((s) => s.history.past.length > 0);
  const canRedo = useStudio((s) => s.history.future.length > 0);
  const { setTool, setOrientation, updateSettings, undo, redo } = studioStore.getState();

  return (
    <div className={styles.toolbar} role="toolbar" aria-label="Studio tools">
      {sceneMenu}

      <div className={styles.shapes} role="group" aria-label="Add a shape">
        {PRIMITIVE_TYPES.map((type) => (
          <button key={type} type="button" className={styles.shape} aria-label={`Add ${PRIMITIVE_LABELS[type]}`} onClick={() => onAdd(type)}>
            {PRIMITIVE_LABELS[type]}
          </button>
        ))}
      </div>

      <Segmented label="Tool" name="studioTool" options={TOOLS} value={tool} onChange={setTool} />
      <Segmented label="Axes" name="studioOrientation" options={ORIENTATIONS} value={orientation} onChange={setOrientation} />

      {settings && (
        <div className={styles.steps}>
          <label className={styles.check}>
            <input type="checkbox" checked={settings.snap} onChange={(e) => updateSettings({ snap: e.target.checked })} />
            Snap
          </label>
          <label>
            <span className={styles.stepLabel}>Move step</span>
            <select value={settings.moveStep} onChange={(e) => updateSettings({ moveStep: Number(e.target.value) })}>
              {MOVE_STEPS.map((m) => (
                <option key={m} value={m}>
                  {formatLength(m, settings.displayUnit)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className={styles.stepLabel}>Turn step</span>
            <select value={settings.rotateStep} onChange={(e) => updateSettings({ rotateStep: Number(e.target.value) })}>
              {ROTATE_STEPS.map((d) => (
                <option key={d} value={d}>
                  {d}°
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className={styles.stepLabel}>Units</span>
            <select value={settings.displayUnit} onChange={(e) => updateSettings({ displayUnit: e.target.value as DisplayUnit })}>
              {Object.entries(DISPLAY_UNITS).map(([unit, { label }]) => (
                <option key={unit} value={unit}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      <div className={styles.history}>
        <button type="button" onClick={undo} disabled={!canUndo}>
          Undo
        </button>
        <button type="button" onClick={redo} disabled={!canRedo}>
          Redo
        </button>
      </div>

      <p className={styles.save} role="status" data-state={saveState.kind}>
        {saveState.kind === 'saved' && 'Saved'}
        {saveState.kind === 'saving' && 'Saving…'}
        {saveState.kind === 'failed' && (
          <>
            <span title={saveState.message}>Not saved</span>{' '}
            <button type="button" onClick={onRetry}>
              Try again
            </button>
          </>
        )}
      </p>
    </div>
  );
}
