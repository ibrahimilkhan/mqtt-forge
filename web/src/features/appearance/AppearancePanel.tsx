import { Field } from '../../components/Field';
import { PanelShell } from '../../components/PanelShell';
import { SoundButton } from '../alerts/SoundButton';
import panel from '../../styles/panel.module.css';
import { LOADS, useAppearanceStore } from '../../stores/appearanceStore';
import styles from './AppearancePanel.module.css';
import { SANS, SIZE, type SansId } from './fonts';

// No selector: the panel shows every value, so it must re-render on any change.
export function AppearancePanel({ onClose }: { onClose: () => void }) {
  const { sans, size, health, loadMb, setSans, setSize, setHealth, setLoadMb, reset } =
    useAppearanceStore();

  return (
    <PanelShell title="Settings" named onClose={onClose}>
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

      {/* Not appearance, and the panel is Settings rather than Appearance for this among other
          reasons. It belongs on this screen because it is the same kind of fact as the rest of
          them: an answer about this reader's own machine, kept in this browser. */}
      <div className={panel.row}>
        <Field label="Memory for held messages" htmlFor="load-mb">
          <select
            id="load-mb"
            className={styles.select}
            value={loadMb}
            onChange={(event) => setLoadMb(Number(event.target.value))}
          >
            {LOADS.map((mb) => (
              <option key={mb} value={mb}>
                {mb >= 1000 ? `${mb / 1000} GB` : `${mb} MB`}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {/* The whole point of the number above, said in one line: nothing is thrown away under it.
          A reader who has watched a console lose history wants to know what stops that, and a
          reader who has not should know what the console will do when it has to. */}
      <p className={panel.pickNote}>
        Nothing is dropped until the console is holding this much. Past it, every topic keeps its
        newest 256 kB.
      </p>

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
