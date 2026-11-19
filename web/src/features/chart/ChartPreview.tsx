import { useMemo } from 'react';
import { Segmented } from '../../components/Segmented';
import { fitDistribution } from '../../lib/distribution';
import { ends } from '../../lib/format';
import { domainFor, positionIn, type ScaleId } from '../../lib/scale';
import { shapeOf } from '../../lib/shape';
import { cadence, changePoint, cycle, summarise } from '../../lib/stats';
import { READINGS, showsReading, type ReadingId } from '../appearance/readings';
import { ChartNote } from '../monitor/ChartNote';
import styles from './ChartPanel.module.css';
import { SAMPLE_IDS, SAMPLES, sampleRun, type SampleId } from './sample';

/** The plot's own box. Stretched to whatever the column gives it, so only the ratio is real. */
const WIDE = 600;
const TALL = 200;
/** Kept clear above and below, so a line along an edge is not drawn half outside the plot. */
const EDGE = 10;

/**
 * A chart to try the settings on, since the real one is behind the panel.
 *
 * The panel takes the workspace — see Workspace's note on `fill` — so the plot these settings
 * change is not on screen while they are being changed, and a reader would be choosing a range
 * and two dozen readings with nothing to see them on. This stands in for it.
 *
 * It goes through the same summary, shape, domain and note the chart does, rather than a copy of
 * their arithmetic: a preview that disagreed with the chart about what `mid` clips would be worse
 * than no preview. Only the line itself is drawn here, because the chart's own plot measures its
 * pane, follows the pointer and reads the log, and none of that has anything to do in a sample.
 */
export function ChartPreview({
  scale,
  readings,
  sample,
  onSample,
  hot,
  moved,
}: {
  scale: ScaleId;
  readings: Partial<Record<ReadingId, boolean>>;
  sample: SampleId;
  onSample: (id: SampleId) => void;
  /** The reading whose switch is under the pointer, to be pointed at in the note. */
  hot: ReadingId | null;
  /** Whether the sample was changed for the reader, by a switch that needed the other one. */
  moved: boolean;
}) {
  const stats = useMemo(() => {
    const run = sampleRun(sample);
    const values = run.map((reading) => reading.value);
    const summary = summarise(values)!;
    const shape = shapeOf(run, summary);

    return {
      run,
      values,
      summary,
      shape,
      fit: fitDistribution(values),
      pace: cadence(run.map((reading) => reading.at)),
      step: shape.id === 'continuous' ? changePoint(values) : null,
      period: shape.id === 'continuous' ? cycle(values) : null,
    };
  }, [sample]);

  // The chart's own rule, in the chart's own words: a quantity takes the range that was chosen,
  // and anything counted is drawn on its extremes whatever was chosen.
  const counted = stats.shape.id !== 'continuous';
  const used = counted ? 'extremes' : scale;
  const domain = useMemo(
    () => domainFor(stats.values, stats.summary, used),
    [stats.values, stats.summary, used],
  );

  const across = (at: number) => (at / (stats.values.length - 1)) * WIDE;
  const up = (value: number) => EDGE + (1 - positionIn(domain, value)) * (TALL - EDGE * 2);

  // A switch holds its level until the next reading and then moves at once, so its line is
  // drawn in steps. Joined corner to corner it would show ramps the run never made.
  const line = stats.values
    .map((value, at) => {
      const point = `${across(at).toFixed(1)},${up(value).toFixed(1)}`;

      return counted && at > 0
        ? `${across(at).toFixed(1)},${up(stats.values[at - 1]).toFixed(1)} ${point}`
        : point;
    })
    .join(' ');

  const rings =
    !counted && showsReading('outliers', readings)
      ? stats.summary.outliers.map((at) => ({
          at,
          left: `${((across(at) / WIDE) * 100).toFixed(2)}%`,
          top: `${((up(stats.values[at]) / TALL) * 100).toFixed(2)}%`,
        }))
      : [];

  const [low, high] = ends(domain.low, domain.high);
  const off = hot !== null && !showsReading(hot, readings);

  return (
    <aside className={styles.preview} aria-labelledby="chart-preview-title" data-testid="chart-preview">
      {/* Outside the card and set as the Range heading is, so the two columns open on the same
          line and their first boxes on the same line under it. Inside the card it stood half a
          line above the heading beside it, and the two columns read as not belonging together. */}
      <h3 className={styles.heading} id="chart-preview-title">
        Preview
      </h3>
      <div className={styles.previewCard}>
      <Segmented
        label="Sample"
        name="chart-sample"
        options={SAMPLE_IDS.map((id) => ({ value: id, label: SAMPLES[id].label }))}
        value={sample}
        onChange={onSample}
      />

      {/* A figure, because the note is a figcaption and is only a caption inside one. */}
      <figure className={styles.sample} data-hot={hot ?? undefined}>
        <div className={styles.plot}>
          <svg
            viewBox={`0 0 ${WIDE} ${TALL}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`A sample ${SAMPLES[sample].label.toLowerCase()} run, drawn in the range selected`}
          >
            <path className={styles.quarters} d={`M0 ${TALL / 4}H${WIDE}M0 ${TALL / 2}H${WIDE}M0 ${(TALL * 3) / 4}H${WIDE}`} />
            <polyline className={styles.trace} points={line} />
          </svg>
          {/* Outside the svg: it is stretched to the column, and a circle drawn inside it would
              be stretched into an ellipse with it. */}
          {rings.map((ring) => (
            <span
              key={ring.at}
              className={styles.ring}
              style={{ left: ring.left, top: ring.top }}
              aria-hidden="true"
            />
          ))}
          <span className={styles.high}>{high}</span>
          <span className={styles.low}>{low}</span>
        </div>

        <ChartNote
          summary={stats.summary}
          shape={stats.shape}
          domain={domain}
          fit={stats.fit}
          pace={stats.pace}
          step={stats.step}
          stepAt={stats.step ? stats.run[stats.step.at].at : null}
          period={stats.period}
          skipped={0}
          chosen={readings}
          asked={used}
          hot={hot}
        />
      </figure>

      {/* Polite, so a sample that was changed for the reader says so rather than only doing it. */}
      <p className={styles.previewNote} aria-live="polite">
        {off
          ? `${READINGS[hot].label} is off, so it is not under the chart.`
          : `${moved ? `Showing the ${SAMPLES[sample].label.toLowerCase()} sample, where that reading appears. ` : ''}${
              counted
                ? 'A sample run. Switches and pulses are drawn on their extremes, whatever the range.'
                : 'A sample run. A dash means the reading does not apply to it.'
            }`}
      </p>
      </div>
    </aside>
  );
}
