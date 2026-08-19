import { Field } from '../../components/Field';
import { PanelShell } from '../../components/PanelShell';
import panel from '../../styles/panel.module.css';
import { MARKS, type MarkId } from '../brand/marks';
import { useAppearanceStore } from '../../stores/appearanceStore';
import styles from './AppearancePanel.module.css';
import { MONO, SANS, SIZE, type MonoId, type SansId } from './fonts';

// No selector: the panel shows every value, so it must re-render on any change.
export function AppearancePanel({ onClose }: { onClose: () => void }) {
  const { sans, mono, size, logo, setSans, setMono, setSize, setLogo, reset } = useAppearanceStore();

  return (
    <PanelShell title="Settings" onClose={onClose}>
      <div className={panel.row}>
        <Field label="Sans font" htmlFor="sans-font">
          <select
            id="sans-font"
            className={styles.select}
            value={sans}
            onChange={(event) => setSans(event.target.value as SansId)}
          >
            {Object.entries(SANS).map(([id, font]) => (
              <option key={id} value={id}>
                {font.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className={panel.row}>
        <Field label="Mono font" htmlFor="mono-font">
          <select
            id="mono-font"
            className={styles.select}
            value={mono}
            onChange={(event) => setMono(event.target.value as MonoId)}
          >
            {Object.entries(MONO).map(([id, font]) => (
              <option key={id} value={id}>
                {font.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className={panel.row}>
        <Field label="Base size" htmlFor="base-size">
          <div className={styles.slider}>
            <input
              id="base-size"
              type="range"
              min={SIZE.min}
              max={SIZE.max}
              step={SIZE.step}
              value={size}
              // Otherwise a screen reader reads the bare number with no unit.
              aria-valuetext={`${size} pixels`}
              onChange={(event) => setSize(Number(event.target.value))}
            />
            <span className={styles.reading}>{size}px</span>
          </div>
        </Field>
      </div>

      <div className={panel.row}>
        {/* Shown rather than named: nobody can pick a mark off a list of six words, and the
            marks are small enough that all six fit on one row of the panel. */}
        <span className={styles.markLabel} id="mark-label">
          Mark
        </span>
        <div className={styles.marks} role="group" aria-labelledby="mark-label">
          {(Object.keys(MARKS) as MarkId[]).map((id) => (
            <button
              key={id}
              type="button"
              className={styles.markBtn}
              aria-label={`${MARKS[id].label} — ${MARKS[id].about}`}
              title={`${MARKS[id].label} — ${MARKS[id].about}`}
              aria-pressed={logo === id}
              onClick={() => setLogo(id)}
            >
              {MARKS[id].draw()}
              <span className={styles.markName}>{MARKS[id].label}</span>
            </button>
          ))}
        </div>
      </div>

      <p className={panel.note}>Stored in this browser only.</p>

      <div className={panel.actions}>
        <button type="button" className="ghost" onClick={reset}>
          Restore defaults
        </button>
      </div>
    </PanelShell>
  );
}
