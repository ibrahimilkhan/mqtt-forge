import { useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { Series } from '../../lib/series';
import type { Summary } from '../../lib/stats';
import styles from './TrafficChart.module.css';

/** The plot is drawn in a unit square and stretched to the pane; see `preserveAspectRatio`. */
const SIDE = 100;

/** Below this a band and a mean line are furniture over a handful of points. */
const ENOUGH_FOR_A_BAND = 5;

/** Keeps the readout over the plot at either end of the run, rather than hanging off it. */
const shift = (index: number, count: number) =>
  index === 0 ? 'none' : index === count - 1 ? 'translateX(-100%)' : 'translateX(-50%)';

/**
 * What the readings have been doing, in order.
 *
 * The newest value says where a sensor is; a topic under traffic is usually asked where it has
 * been going, and that is a shape rather than a number.
 */
export function TrafficLine({
  series,
  summary,
  colour,
  marks = true,
}: {
  series: Series;
  summary: Summary;
  colour?: string;
  /** The band, the mean and the outlier rings — everything drawn that is not a reading. */
  marks?: boolean;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const { readings, low, high } = series;

  // A flat run has no range to scale against: down the middle, rather than a division by zero.
  // A straight line is exactly what a topic repeating one value should show.
  const span = high - low;
  const y = (value: number) =>
    span === 0 ? SIDE / 2 : Math.min(Math.max(SIDE - ((value - low) / span) * SIDE, 0), SIDE);

  // One step per reading, not one per second. The log drops a topic's oldest entries as it
  // fills, so the gaps between what it still holds are the trimming's, not the broker's —
  // spacing by arrival time would draw those as silences the sensor never had.
  const x = (index: number) => (index / (readings.length - 1)) * SIDE;

  const line = readings.map((reading, index) => `${x(index)},${y(reading.value)}`).join(' ');
  const latest = readings[readings.length - 1];
  const banded = marks && summary.n >= ENOUGH_FOR_A_BAND && summary.sd > 0;

  const last = readings.length - 1;
  const settle = (step: number) => setHovered(Math.min(Math.max(step, 0), last));

  const follow = (event: PointerEvent<HTMLDivElement>) => {
    const { left, width } = event.currentTarget.getBoundingClientRect();
    if (!width) return;

    settle(Math.round(((event.clientX - left) / width) * last));
  };

  /**
   * The same walk, without a pointer.
   *
   * A chart whose values can only be read by holding a mouse over them is a chart half the
   * readers cannot read at all — and on a run of a thousand, arrow keys are the only way to land
   * on one reading exactly rather than near it.
   */
  const walk = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = hovered ?? last;
    const steps: Record<string, number> = { ArrowLeft: at - 1, ArrowRight: at + 1, Home: 0, End: last };
    const next = steps[event.key];
    if (next === undefined) return;

    event.preventDefault();
    settle(next);
  };

  return (
    <div className={styles.frame}>
      {/* The line says the shape and the labels say the size of it, which is the one thing a
          sparkline cannot carry on its own. Muted, like the stamps: this is furniture. A run
          that never moved has one number to give, not the same one twice. */}
      <div
        className={styles.scale}
        // With one label and a line down the middle, the label belongs beside the line.
        data-flat={span === 0 ? '' : undefined}
        aria-hidden="true"
      >
        <span>{high}</span>
        {span !== 0 && <span>{low}</span>}
      </div>

      <div className={styles.plotArea}>
        {/* The shape is the whole point, so the words standing in for it carry the same facts:
            how many readings, of what, over what range, and where they ended up. */}
        <div
          className={styles.plot}
          data-testid="plotArea"
          role="img"
          aria-label={`${readings.length} readings${series.field ? ` of ${series.field}` : ''} on ${series.topic}, ${low} to ${high}, latest ${latest.value}. Arrow keys walk the readings.`}
          // Focusable so the readings can be walked without a pointer. Landing on it starts at
          // the newest reading, which is the one the row above is showing.
          tabIndex={0}
          onPointerMove={follow}
          onPointerLeave={() => setHovered(null)}
          onFocus={() => setHovered((at) => at ?? last)}
          onBlur={() => setHovered(null)}
          onKeyDown={walk}
        >
          <svg
            className={styles.plotSvg}
            viewBox={`0 0 ${SIDE} ${SIDE}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {/* One deviation either side of the mean, which is where the readings mostly are.
                The line crossing out of it is the part worth looking at. */}
            {banded && (
              <rect
                className={styles.band}
                x={0}
                y={y(summary.mean + summary.sd)}
                width={SIDE}
                height={Math.max(y(summary.mean - summary.sd) - y(summary.mean + summary.sd), 0)}
              >
                {/* A line drawn across a chart with nothing to say what it is is a mystery the
                    reader has to solve before they can read anything else. */}
                <title>mean, and one deviation either side of it</title>
              </rect>
            )}
            {banded && (
              <line className={styles.mean} x1={0} y1={y(summary.mean)} x2={SIDE} y2={y(summary.mean)} />
            )}

            {/* Where a reading can go either way, which side of nothing it is on is the first
                thing read off the shape — and the line alone cannot say where nothing is. */}
            {low < 0 && high > 0 && (
              <line className={styles.zero} data-testid="zero" x1={0} y1={y(0)} x2={SIDE} y2={y(0)}>
                <title>zero</title>
              </line>
            )}

            {hovered !== null && (
              <line className={styles.crosshair} x1={x(hovered)} y1={0} x2={x(hovered)} y2={SIDE} />
            )}

            {/* Stretched by the viewBox, so the stroke is pinned to device pixels rather than
                scaled with it — otherwise a wide pane draws a thick line and a narrow one a hair. */}
            <polyline
              data-testid="plot"
              className={styles.plotLine}
              points={line}
              fill="none"
              stroke={colour ?? 'currentColor'}
            />
          </svg>

          {/* Round dots and real type, in HTML: both would be stretched out of shape inside the
              viewBox above. The dot marks where the run ends, which is the row above it. */}
          <span
            className={styles.head}
            style={{ left: `${x(readings.length - 1)}%`, top: `${y(latest.value)}%` }}
          />

          {/* A reading past the fences is either the event the sensor was put there to catch or
              a fault in it, and either way it is the one to look at first. */}
          {marks && summary.outliers.map((index) => (
            <span
              key={index}
              className={styles.outlier}
              data-testid="outlier"
              style={{ left: `${x(index)}%`, top: `${y(readings[index].value)}%` }}
            />
          ))}

          {hovered !== null && (
            <span
              className={styles.reading}
              data-testid="reading"
              aria-hidden="true"
              // Centred on the reading, except at the ends, where a centred label would hang off
              // the pane: there it sits inside the run it belongs to.
              style={{ left: `${x(hovered)}%`, transform: shift(hovered, readings.length) }}
              title={readings[hovered].at.toLocaleTimeString('en-GB', { hour12: false })}
            >
              {readings[hovered].value}
            </span>
          )}
        </div>

        {/* Outside the plot on purpose: role="img" makes everything inside it presentational, so
            a live region in there would announce nothing. This is the same readout in words. */}
        <span className="srOnly" data-testid="spoken" aria-live="polite">
          {hovered === null
            ? ''
            : `${readings[hovered].value} at ${readings[hovered].at.toLocaleTimeString('en-GB', { hour12: false })}, reading ${hovered + 1} of ${readings.length}`}
        </span>
      </div>
    </div>
  );
}
