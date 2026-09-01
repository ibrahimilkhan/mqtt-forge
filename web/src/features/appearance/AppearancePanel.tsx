import { Field } from '../../components/Field';
import { PanelShell } from '../../components/PanelShell';
import { SoundButton } from '../alerts/SoundButton';
import panel from '../../styles/panel.module.css';
import { useAppearanceStore } from '../../stores/appearanceStore';
import styles from './AppearancePanel.module.css';
import { SANS, SIZE, type SansId } from './fonts';

// No selector: the panel shows every value, so it must re-render on any change.
export function AppearancePanel({ onClose }: { onClose: () => void }) {
  const { sans, size, health, setSans, setSize, setHealth, reset } =
    useAppearanceStore();

  return (
    <PanelShell title="Settings" onClose={onClose}>
      <div className={panel.row}>
        <Field label="Font" htmlFor="sans-font">
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

      <div className={panel.checks}>
        <label>
          <input
            type="checkbox"
            checked={health}
            onChange={(event) => setHealth(event.target.checked)}
          />
          {' Show performance metrics'}
        </label>
      </div>

      {/* It stood at the foot of the alerts panel, on the grounds that alerting's one sound
          control belonged with alerting's other controls. It is not one: a rule says whether it
          wants a tone, and this says whether this browser will make one at all — which is the same
          kind of fact as the face the console is set in and the health line being on, and all
          three are stored in the same place for the same reason. */}
      <div className={panel.actions}>
        <SoundButton />
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
