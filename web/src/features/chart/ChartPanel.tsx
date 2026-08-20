import { Field } from '../../components/Field';
import { PanelShell } from '../../components/PanelShell';
import panel from '../../styles/panel.module.css';
import { SCALES, type ScaleId } from '../../lib/scale';
import { useAppearanceStore } from '../../stores/appearanceStore';
import { CHART_DETAIL, type ChartDetailId } from '../appearance/chart';
import {
  CONTROL_GROUP_TITLES,
  CONTROL_GROUPS,
  CONTROL_IDS,
  CONTROLS,
  RANGE_CHIPS,
} from '../appearance/controls';
import { GRIDS, type GridId } from '../appearance/grid';
import { useExport } from '../monitor/useExport';
import {
  READING_GROUPS,
  READING_IDS,
  READINGS,
  showsReading,
  type ReadingGroup,
} from '../appearance/readings';
import styles from './ChartPanel.module.css';

const GROUPS = Object.keys(READING_GROUPS) as ReadingGroup[];

/**
 * Everything about the chart in one place: how much of it to draw, what range to draw it in, what
 * to draw round it, and which of the readings under it are wanted.
 *
 * The readings are the reason this panel exists. The note prints a dozen labels three or four
 * characters long — `n`, `σ` as 'spread', `duty`, `fences` — and a label that short is only
 * readable by someone who already knows what it stands for. The cells carry titles, which is no
 * help to a reader who does not know there is anything to hover. Here every one of them is
 * written out in full, beside the switch that puts it away.
 */
export function ChartPanel({ onClose }: { onClose: () => void }) {
  // No selector: the panel shows every value, so it must re-render on any change.
  const { chart, scale, grid, readings, setChart, setScale, setGrid, toggleReading, resetReadings } =
    useAppearanceStore();

  const deep = CHART_DETAIL[chart].histogram;
  const exporter = useExport();

  return (
    <PanelShell title="Chart" onClose={onClose}>
      <div className={panel.row}>
        <Field label="Detail" htmlFor="chart-detail">
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

      <div className={panel.row}>
        <Field label="Range" htmlFor="chart-range">
          <select
            id="chart-range"
            className={styles.select}
            value={scale}
            onChange={(event) => setScale(event.target.value as ScaleId)}
          >
            {Object.entries(SCALES).map(([id, range]) => (
              <option key={id} value={id}>
                {range.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {/* Under the field, not beside it: a panel row is a flex row, and a sentence sharing one
          with a select squeezes the select down to a few characters of its own label. */}
      <p className={panel.note}>
        Runs whose peaks are the signal — pulses, switches — are always drawn on their extremes.
      </p>

      <div className={panel.row}>
        <Field label="Grid" htmlFor="chart-grid">
          <select
            id="chart-grid"
            className={styles.select}
            value={grid}
            onChange={(event) => setGrid(event.target.value as GridId)}
          >
            {Object.entries(GRIDS).map(([id, option]) => (
              <option key={id} value={id}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {/* Not a panel row: that is a flex row for fields that sit beside each other, and these
          are a column of groups. */}
      <section className={styles.readings}>
        <h3 className={styles.heading}>Readings</h3>
        <p className={panel.note}>
          What the note under the chart says, and what each of them means. Which apply depends on
          what the run is — a mean is a fact about a temperature and a fiction about a door.
        </p>

        {GROUPS.map((group) => (
          <fieldset key={group} className={styles.group}>
            <legend className={styles.legend}>{READING_GROUPS[group].title}</legend>
            <p className={styles.about}>{READING_GROUPS[group].about}</p>

            {READING_IDS.filter((id) => READINGS[id].group === group).map((id) => (
              <label key={id} className={styles.reading}>
                {/* The switch is named for the reading and *described* by its meaning, rather than
                    taking both as its name: read aloud, 'mean, checked' and then the sentence is
                    a control with a name; one long run of prose is a control with a paragraph. */}
                <input
                  type="checkbox"
                  aria-labelledby={`reading-${id}`}
                  aria-describedby={`what-${id}`}
                  checked={showsReading(id, readings, deep)}
                  onChange={(event) => toggleReading(id, event.target.checked)}
                />
                <span className={styles.readingText}>
                  <b className={styles.readingLabel} id={`reading-${id}`}>
                    {READINGS[id].label}
                  </b>
                  <span className={styles.readingWhat} id={`what-${id}`}>
                    {READINGS[id].what}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
        ))}
      </section>

      {/* Where csv puts the readings. Its own row rather than a line in the chip's explanation:
          it is a setting, it persists across saves, and a reader who wants to change it should
          not have to press the thing that uses it. */}
      <div className={panel.row}>
        <span className={styles.markLabel} id="save-folder-label">
          Save folder
        </span>
        <div className={styles.folder}>
          <span className={styles.folderPath} data-testid="export-folder" title={exporter.folder ?? undefined}>
            {exporter.canChoose
              ? (exporter.folder ?? 'Not set — csv will ask the first time')
              : 'This browser has no folder dialog, so csv comes down as a download'}
          </span>
          {exporter.canChoose && (
            <button
              type="button"
              className="ghost"
              aria-labelledby="save-folder-label"
              disabled={exporter.choosing}
              onClick={() => exporter.choose()}
            >
              {exporter.folder ? 'Change…' : 'Choose…'}
            </button>
          )}
        </div>
      </div>

      {/* The chips over the plot are three and four characters long, because they share a row
          with a pane that can be two hundred pixels wide. Short is right for the chip and wrong
          for a reader meeting it — and a `title` is a thing you have to already suspect is there.
          So the words live here, beside the readings that are explained the same way. */}
      <section className={styles.readings}>
        <h3 className={styles.heading}>Controls over the plot</h3>

        {CONTROL_GROUPS.map((group) => (
          <fieldset key={group} className={styles.group}>
            <legend className={styles.legend}>{CONTROL_GROUP_TITLES[group].title}</legend>
            <p className={styles.about}>{CONTROL_GROUP_TITLES[group].about}</p>

            {/* In the order the chart puts them in, so the list can be read against the row. */}
            {CONTROL_IDS.filter((id) => CONTROLS[id].group === group).map((id) => (
              <p key={id} className={styles.control}>
                <b className={styles.chip}>{CONTROLS[id].label}</b>
                <span className={styles.what}>
                  {CONTROLS[id].what}
                  {CONTROLS[id].when && <em className={styles.when}> {CONTROLS[id].when}</em>}
                </span>
              </p>
            ))}

            {/* The ranges describe themselves in the scale catalogue the chart draws them from,
                so they are printed from there rather than said a second time here. */}
            {group === 'range' &&
              RANGE_CHIPS.map((chip) => (
                <p key={chip.id} className={styles.control}>
                  <b className={styles.chip}>{chip.label}</b>
                  <span className={styles.what}>{chip.hint}</span>
                </p>
              ))}
          </fieldset>
        ))}
      </section>

      <div className={panel.actions}>
        <button type="button" className="ghost" onClick={resetReadings}>
          Restore every reading
        </button>
      </div>
    </PanelShell>
  );
}
