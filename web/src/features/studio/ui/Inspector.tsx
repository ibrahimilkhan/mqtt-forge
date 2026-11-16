import { useEffect, useRef, useState } from 'react';
import type { Vec3 } from '../geometry/euler';
import { MATERIAL_PRESETS, type MaterialPreset } from '../model/defaults';
import { studioStore, useStudio } from '../studioStore';
import { degToRad, DISPLAY_UNITS, fromDisplay, radToDeg, toDisplay } from '../units/units';
import { NumberField } from './NumberField';
import styles from './Inspector.module.css';

const AXES = ['X', 'Y', 'Z'] as const;

/**
 * A colour picker that is one change however long the reader drags across it. React's `onChange`
 * is the DOM's `input` here, sent on every move; the DOM's own `change` comes once the choice is
 * made, so that is what is written — the moves before it only show in the swatch.
 */
function ColourField({ value, onCommit }: { value: string; onCommit: (value: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [shown, setShown] = useState(value);
  useEffect(() => setShown(value), [value]);
  const commit = useRef(onCommit);
  useEffect(() => {
    commit.current = onCommit;
  }, [onCommit]);
  useEffect(() => {
    const element = input.current;
    if (!element) return;
    const done = () => commit.current(element.value);
    element.addEventListener('change', done);
    return () => element.removeEventListener('change', done);
  }, []);
  return <input ref={input} type="color" aria-label="Colour" value={shown} onChange={(e) => setShown(e.target.value)} />;
}

/** The selected object's name, transform and look, each change one undo step. */
export function Inspector() {
  const object = useStudio((s) => (s.selection.length === 1 ? s.scene?.objects.find((o) => o.id === s.selection[0]) : undefined));
  const settings = useStudio((s) => s.scene?.settings);
  const [name, setName] = useState(object?.name ?? '');
  useEffect(() => setName(object?.name ?? ''), [object?.name]);

  if (!object || !settings) return <aside className={styles.inspector} aria-label="Inspector"><p className={styles.empty}>Select an object to see and change it here.</p></aside>;

  const { updateObject, setEuler, rename } = studioStore.getState();
  const unit = settings.displayUnit;
  const withAxis = (v: Vec3, axis: number, value: number): Vec3 => v.map((c, i) => (i === axis ? value : c)) as Vec3;
  const preset = (Object.keys(MATERIAL_PRESETS) as MaterialPreset[]).find(
    (key) => MATERIAL_PRESETS[key].metal === (object.mat?.metal ?? 0) && MATERIAL_PRESETS[key].rough === (object.mat?.rough ?? 0.5),
  );

  return (
    <aside className={styles.inspector} aria-label="Inspector">
      <label className={styles.field}>
        <span>Name</span>
        <input
          type="text"
          aria-label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => rename(object.id, name)}
          onKeyDown={(e) => e.key === 'Enter' && rename(object.id, name)}
        />
      </label>

      {/* An import that found no model inside the DesignBox file has nothing kept to draw later. */}
      {object.type === 'model' && (object.model ? (
        <p className={styles.note}>
          A placeholder for the model file {object.model.ext}. The studio keeps the file and draws it once model loading arrives.
        </p>
      ) : (
        <p className={styles.note}>
          The DesignBox file carried no model data for this object, so it stands here as a placeholder.
        </p>
      ))}

      <fieldset className={styles.group}>
        <legend>Position ({DISPLAY_UNITS[unit].label})</legend>
        {AXES.map((axis, i) => (
          <NumberField
            key={axis}
            label={`Position ${axis}`}
            value={toDisplay(object.position[i], unit)}
            length
            unit={unit}
            step={toDisplay(settings.moveStep, unit)}
            digits={DISPLAY_UNITS[unit].digits}
            onCommit={(v) => updateObject(object.id, { position: withAxis(object.position, i, fromDisplay(v, unit)) })}
          />
        ))}
      </fieldset>

      <fieldset className={styles.group}>
        <legend>Rotation (°)</legend>
        {AXES.map((axis, i) => (
          <NumberField
            key={axis}
            label={`Rotation ${axis}`}
            value={radToDeg(object.euler[i])}
            step={settings.rotateStep}
            digits={2}
            onCommit={(v) => setEuler(object.id, withAxis(object.euler, i, degToRad(v)))}
          />
        ))}
      </fieldset>

      <fieldset className={styles.group}>
        <legend>Scale</legend>
        {AXES.map((axis, i) => (
          <NumberField
            key={axis}
            label={`Scale ${axis}`}
            value={object.scaling[i]}
            step={0.1}
            accepts={(v) => v > 0}
            onCommit={(v) => updateObject(object.id, { scaling: withAxis(object.scaling, i, v) })}
          />
        ))}
      </fieldset>

      {object.type !== 'model' && (
        <fieldset className={styles.group}>
          <legend>Look</legend>
          <label className={styles.field}>
            <span>Colour</span>
            <ColourField value={object.color ?? '#888888'} onCommit={(color) => updateObject(object.id, { color })} />
          </label>
          <label className={styles.field}>
            <span>Material</span>
            <select
              aria-label="Material"
              value={preset ?? ''}
              onChange={(e) => {
                const chosen = MATERIAL_PRESETS[e.target.value as MaterialPreset];
                updateObject(object.id, { mat: { metal: chosen.metal, rough: chosen.rough } });
              }}
            >
              {!preset && <option value="">Custom</option>}
              {(Object.keys(MATERIAL_PRESETS) as MaterialPreset[]).map((key) => (
                <option key={key} value={key}>
                  {MATERIAL_PRESETS[key].label}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.check}>
            <input type="checkbox" checked={object.transparent ?? false} onChange={(e) => updateObject(object.id, { transparent: e.target.checked })} />
            See-through
          </label>
        </fieldset>
      )}
    </aside>
  );
}
