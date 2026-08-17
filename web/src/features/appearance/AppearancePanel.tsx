import { Field } from '../../components/Field';
import { PanelShell } from '../../components/PanelShell';
import panel from '../../styles/panel.module.css';
import { useAppearanceStore } from '../../stores/appearanceStore';
import styles from './AppearancePanel.module.css';
import { CHART_DETAIL, type ChartDetailId } from './chart';
import { MONO, SANS, SIZE, type MonoId, type SansId } from './fonts';

// No selector: the panel shows every value, so it must re-render on any change.
export function AppearancePanel({ onClose }: { onClose: () => void }) {
  const { sans, mono, size, chart, setSans, setMono, setSize, setChart, reset } = useAppearanceStore();

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
        <Field label="Chart detail" htmlFor="chart-detail">
          <select
            id="chart-detail"
            className={styles.select}
            value={chart}
            onChange={(event) => setChart(event.target.value as ChartDetailId)}
          >
            {Object.entries(CHART_DETAIL).map(([id, detail]) => (
              <option key={id} value={id}>
                {detail.label}
              </option>
            ))}
          </select>
        </Field>
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
