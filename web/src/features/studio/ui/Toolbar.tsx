import { useRef, type ComponentType, type KeyboardEvent, type ReactNode } from 'react';
import { useStudioLayout } from '../layoutStore';
import { PRIMITIVE_LABELS, PRIMITIVE_TYPES } from '../model/defaults';
import type { PrimitiveType } from '../model/document';
import { studioStore, useStudio, type Tool } from '../studioStore';
import { DISPLAY_UNITS, formatLength, type DisplayUnit } from '../units/units';
import {
  CheckGlyph,
  ChevronDownGlyph,
  ClockGlyph,
  LocalGlyph,
  MagnetGlyph,
  MoveGlyph,
  PlusGlyph,
  RedoGlyph,
  RetryGlyph,
  RotateGlyph,
  RulerGlyph,
  ScaleGlyph,
  SelectGlyph,
  SHAPE_GLYPHS,
  SlidersGlyph,
  TargetGlyph,
  TreeGlyph,
  UndoGlyph,
  WarningGlyph,
  WorldGlyph,
} from './icons';
import { ToolMenu } from './ToolMenu';
import menu from './ToolMenu.module.css';
import styles from './Toolbar.module.css';

export type SaveState = { kind: 'saved' } | { kind: 'saving' } | { kind: 'failed'; message: string };

/** The four tools, each named with the key that picks it, since the name is all a mark has. */
const TOOLS: ReadonlyArray<{ value: Tool; label: string; key: string; Mark: ComponentType }> = [
  { value: 'select', label: 'Select', key: 'Q', Mark: SelectGlyph },
  { value: 'move', label: 'Move', key: 'W', Mark: MoveGlyph },
  { value: 'rotate', label: 'Rotate', key: 'E', Mark: RotateGlyph },
  { value: 'scale', label: 'Scale', key: 'R', Mark: ScaleGlyph },
];
/** Metres, shown in whichever unit the scene is shown in. */
const MOVE_STEPS = [0.001, 0.01, 0.1, 0.5, 1];
/** Degrees. */
const ROTATE_STEPS = [1, 5, 15, 45, 90];
/** Which way each arrow walks the tool group: on along the row, or back. */
const ARROWS: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

type Props = {
  onAdd: (type: PrimitiveType) => void;
  /** Points the camera at the selection — the engine's to do, so the page hands it down. */
  onFocus: () => void;
  saveState: SaveState;
  onRetry: () => void;
  sceneMenu: ReactNode;
};

/**
 * The tools as one radio group of marks. Buttons wearing the radio role rather than radio inputs:
 * the studio's keys are not taken while the keyboard is in a field, and a radio input is one — so
 * with the keyboard on the Move radio, W and E would have stopped switching tools. The arrows walk
 * the group and pick as they go, as a radio group's do, and only the chosen one is a Tab stop.
 */
function ToolRadios() {
  const tool = useStudio((s) => s.tool);
  const group = useRef<HTMLDivElement>(null);
  const { setTool } = studioStore.getState();

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = ARROWS[event.key];
    if (!step) return;
    event.preventDefault();
    const at = TOOLS.findIndex((t) => t.value === tool);
    const next = (at + step + TOOLS.length) % TOOLS.length;
    setTool(TOOLS[next].value);
    group.current?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
  };

  return (
    <div ref={group} className={styles.group} role="radiogroup" aria-label="Tool" onKeyDown={onKeyDown}>
      {TOOLS.map(({ value, label, key, Mark }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={tool === value}
          tabIndex={tool === value ? 0 : -1}
          className={styles.icon}
          aria-label={`${label} (${key})`}
          title={`${label} (${key})`}
          onClick={() => setTool(value)}
        >
          <Mark />
        </button>
      ))}
    </div>
  );
}

/** Whether the scene is written, as a mark and a word at the far end of the row. */
function SaveStatus({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
  return (
    <p className={styles.save} role="status" data-state={state.kind}>
      {state.kind === 'saved' && (
        <>
          <CheckGlyph /> Saved
        </>
      )}
      {state.kind === 'saving' && (
        <>
          <ClockGlyph /> Saving…
        </>
      )}
      {state.kind === 'failed' && (
        <>
          <WarningGlyph /> <span title={state.message}>Not saved</span>
          <button type="button" className={styles.icon} aria-label="Try again" title={`Try again — ${state.message}`} onClick={onRetry}>
            <RetryGlyph />
          </button>
        </>
      )}
    </p>
  );
}

/** The mark of a button that opens a dropdown, with the small chevron that says it opens one. */
const Opens = ({ children }: { children: ReactNode }) => (
  <>
    {children}
    <span className={styles.chevron}>
      <ChevronDownGlyph />
    </span>
  </>
);

/**
 * Along the top of the studio, on one row of small marks in groups: the scene, the shapes, the
 * tool and its axes, the snap and its steps, undo, what is shown, and whether it is saved. Each
 * mark gives its name and its key as a tooltip, and the same to a screen reader as its name.
 * Whatever is not pressed often folds into a dropdown, so the row stays one row; on a narrow
 * window it scrolls sideways rather than wrapping onto a second.
 */
export function Toolbar({ onAdd, onFocus, saveState, onRetry, sceneMenu }: Props) {
  const orientation = useStudio((s) => s.orientation);
  const settings = useStudio((s) => s.scene?.settings);
  const canUndo = useStudio((s) => s.history.past.length > 0);
  const canRedo = useStudio((s) => s.history.future.length > 0);
  const selected = useStudio((s) => s.selection.length > 0);
  const treeOpen = useStudioLayout((s) => s.treeOpen);
  const inspectorOpen = useStudioLayout((s) => s.inspectorOpen);
  const { setTreeOpen, setInspectorOpen } = useStudioLayout.getState();
  const { setOrientation, updateSettings, undo, redo } = studioStore.getState();
  const local = orientation === 'local';

  return (
    <div className={styles.toolbar} role="toolbar" aria-label="Studio tools">
      <div className={styles.group} role="group" aria-label="Scene">
        {sceneMenu}
      </div>

      <div className={styles.group} role="group" aria-label="Add">
        <ToolMenu kind="menu" title="Add a shape" ariaLabel="Add a shape" triggerClassName={styles.opens} trigger={<Opens><PlusGlyph /></Opens>}>
          {(close) =>
            PRIMITIVE_TYPES.map((type) => {
              const Mark = SHAPE_GLYPHS[type];
              return (
                <button
                  key={type}
                  type="button"
                  role="menuitem"
                  className={menu.item}
                  onClick={() => {
                    onAdd(type);
                    close();
                  }}
                >
                  <Mark />
                  {PRIMITIVE_LABELS[type]}
                </button>
              );
            })
          }
        </ToolMenu>
      </div>

      <ToolRadios />

      <div className={styles.group} role="group" aria-label="Axes">
        {/* One button rather than a pair: its name says which frame is in use, a press swaps it. */}
        <button
          type="button"
          className={styles.icon}
          aria-label={`Axes: ${local ? 'Local' : 'World'}`}
          title={`Axes: ${local ? 'Local' : 'World'} — press for ${local ? 'World' : 'Local'}`}
          onClick={() => setOrientation(local ? 'world' : 'local')}
        >
          {local ? <LocalGlyph /> : <WorldGlyph />}
        </button>
      </div>

      {settings && (
        <div className={styles.group} role="group" aria-label="Snap">
          <button
            type="button"
            className={styles.icon}
            aria-label="Snap"
            title="Snap to steps"
            aria-pressed={settings.snap}
            onClick={() => updateSettings({ snap: !settings.snap })}
          >
            <MagnetGlyph />
          </button>
          <ToolMenu kind="dialog" title="Snap steps" ariaLabel="Snap steps" triggerClassName={styles.opens} trigger={<Opens><RulerGlyph /></Opens>}>
            <label className={styles.field}>
              <span>Move step</span>
              <select value={settings.moveStep} onChange={(e) => updateSettings({ moveStep: Number(e.target.value) })}>
                {MOVE_STEPS.map((m) => (
                  <option key={m} value={m}>
                    {formatLength(m, settings.displayUnit)}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.field}>
              <span>Turn step</span>
              <select value={settings.rotateStep} onChange={(e) => updateSettings({ rotateStep: Number(e.target.value) })}>
                {ROTATE_STEPS.map((d) => (
                  <option key={d} value={d}>
                    {d}°
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.field}>
              <span>Units</span>
              <select value={settings.displayUnit} onChange={(e) => updateSettings({ displayUnit: e.target.value as DisplayUnit })}>
                {Object.entries(DISPLAY_UNITS).map(([unit, { label }]) => (
                  <option key={unit} value={unit}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </ToolMenu>
        </div>
      )}

      <div className={styles.group} role="group" aria-label="History">
        <button type="button" className={styles.icon} aria-label="Undo (Ctrl+Z)" title="Undo (Ctrl+Z)" onClick={undo} disabled={!canUndo}>
          <UndoGlyph />
        </button>
        <button type="button" className={styles.icon} aria-label="Redo (Ctrl+Y)" title="Redo (Ctrl+Y)" onClick={redo} disabled={!canRedo}>
          <RedoGlyph />
        </button>
      </div>

      <div className={styles.group} role="group" aria-label="View">
        <button
          type="button"
          className={styles.icon}
          aria-label="Object tree"
          title="Object tree"
          aria-pressed={treeOpen}
          onClick={() => setTreeOpen(!treeOpen)}
        >
          <TreeGlyph />
        </button>
        <button
          type="button"
          className={styles.icon}
          aria-label="Inspector"
          title="Inspector — shown while something is selected"
          aria-pressed={inspectorOpen}
          onClick={() => setInspectorOpen(!inspectorOpen)}
        >
          <SlidersGlyph />
        </button>
        <button type="button" className={styles.icon} aria-label="Focus selection (F)" title="Focus selection (F)" onClick={onFocus} disabled={!selected}>
          <TargetGlyph />
        </button>
      </div>

      <SaveStatus state={saveState} onRetry={onRetry} />
    </div>
  );
}
