import { useState, type PointerEvent } from 'react';
import type { ColourRule } from '../../lib/topicColour';
import type { Series } from '../../lib/series';
import styles from './WireLog.module.css';

/** The plot is drawn in a unit square and stretched to the pane; see `preserveAspectRatio`. */
const SIDE = 100;

/** Keeps the readout over the plot at either end of the run, rather than hanging off it. */
const shift = (index: number, count: number) =>
  index === 0 ? 'none' : index === count - 1 ? 'translateX(-100%)' : 'translateX(-50%)';

/**
 * What a run of readings did, in the space the rows cannot use.
 *
 * The newest value says where a sensor is; a topic under traffic is usually asked where it has
 * been going, and that is a shape rather than a number. The chart carries the whole history the
 * pane holds, so it also shows what the single row on screen is standing in front of.
 */
export function TrafficChart({ series, rule }: { series: Series; rule?: ColourRule | null }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const { readings, low, high } = series;

  // A flat run has no range to scale against: down the middle, rather than a division by zero.
  // A straight line is exactly what a topic repeating one value should show.
  const span = high - low;
  const y = (value: number) => (span === 0 ? SIDE / 2 : SIDE - ((value - low) / span) * SIDE);

  // One step per reading, not one per second. The log drops a topic's oldest entries as it
  // fills, so the gaps between what it still holds are the trimming's, not the broker's —
  // spacing by arrival time would draw those as silences the sensor never had.
  const x = (index: number) => (index / (readings.length - 1)) * SIDE;

  const line = readings.map((reading, index) => `${x(index)},${y(reading.value)}`).join(' ');
  const latest = readings[readings.length - 1];

  const follow = (event: PointerEvent<HTMLDivElement>) => {
    const { left, width } = event.currentTarget.getBoundingClientRect();
    if (!width) return;

    const step = Math.round(((event.clientX - left) / width) * (readings.length - 1));
    setHovered(Math.min(Math.max(step, 0), readings.length - 1));
  };

  return (
    // The shape is the whole point, so the words standing in for it carry the same facts: how
    // many readings, over what range, and where they ended up. Everything inside is presentation.
    <figure
      className={styles.chart}
      data-testid="chart"
      role="img"
      aria-label={`${readings.length} readings on ${series.topic}, ${low} to ${high}, latest ${latest.value}`}
      style={rule ? { color: rule.colour } : undefined}
    >
      {/* The line says the shape and the labels say the size of it, which is the one thing a
          sparkline cannot carry on its own. Muted, like the stamps: this is furniture. A run
          that never moved has one number to give, not the same one twice. */}
      <div className={styles.scale} aria-hidden="true">
        <span>{high}</span>
        {span !== 0 && <span>{low}</span>}
      </div>

      <div
        className={styles.plotArea}
        data-testid="plotArea"
        onPointerMove={follow}
        onPointerLeave={() => setHovered(null)}
      >
        <svg
          className={styles.plotSvg}
          viewBox={`0 0 ${SIDE} ${SIDE}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {/* Where a reading can go either way, which side of nothing it is on is the first thing
              read off the shape — and the line alone cannot say where nothing is. */}
          {low < 0 && high > 0 && (
            <line className={styles.zero} data-testid="zero" x1={0} y1={y(0)} x2={SIDE} y2={y(0)} />
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
            stroke={rule?.colour ?? 'currentColor'}
          />
        </svg>

        {/* Round dots and real type, in HTML: both would be stretched out of shape inside the
            viewBox above. The dot marks where the run ends, which is the row above it. */}
        <span
          className={styles.head}
          style={{ left: `${x(readings.length - 1)}%`, top: `${y(latest.value)}%` }}
        />

        {hovered !== null && (
          <span
            className={styles.reading}
            data-testid="reading"
            // Centred on the reading, except at the ends, where a centred label would hang off
            // the pane: there it sits inside the run it belongs to.
            style={{ left: `${x(hovered)}%`, transform: shift(hovered, readings.length) }}
            title={readings[hovered].at.toLocaleTimeString('en-GB', { hour12: false })}
          >
            {readings[hovered].value}
          </span>
        )}
      </div>
    </figure>
  );
}
