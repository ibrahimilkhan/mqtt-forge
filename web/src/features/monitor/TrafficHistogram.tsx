import { useState } from 'react';
import type { GridId } from '../appearance/grid';
import { short } from '../../lib/format';
import { PlotGrid } from './PlotGrid';
import type { Series } from '../../lib/series';
import type { Summary } from '../../lib/stats';
import styles from './TrafficChart.module.css';

const SIDE = 100;

/** Enough bars to show a shape, few enough that each still has readings in it. */
const FEWEST_BINS = 5;
const MOST_BINS = 24;

/**
 * How often each value came up, which is the question the distribution in the note answers.
 *
 * The line says what the readings have been doing; this says what they usually do. A sensor
 * whose line looks busy and whose distribution is one tight hill is a sensor at rest with noise
 * on it — the two views answer different questions about the same run, and a console that only
 * draws the first leaves the second to be guessed at.
 */
export function TrafficHistogram({
  series,
  summary,
  colour,
  grid = 'frame',
}: {
  series: Series;
  summary: Summary;
  colour?: string;
  /** What is drawn round and behind the bars. */
  grid?: GridId;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const bins = binsFor(series.readings.map((reading) => reading.value), summary);
  const tallest = Math.max(...bins.map((bin) => bin.count));
  const width = SIDE / bins.length;

  return (
    <div className={styles.frame}>
      {/* Counts, not readings: the axis changed with the view, so the labels on it change too. */}
      <div className={styles.scale} aria-hidden="true">
        <span>{tallest}</span>
        <span>0</span>
      </div>

      <div className={styles.plotArea}>
        <div
          className={styles.plot}
          data-testid="histogram"
          role="img"
          aria-label={`How often each reading came up: ${bins.length} bins from ${short(summary.low)} to ${short(summary.high)}, the fullest holding ${tallest}`}
        >
          <svg
            className={styles.plotSvg}
            viewBox={`0 0 ${SIDE} ${SIDE}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {/* The same ground the line is drawn on, so two plots stacked read as one chart. */}
            <PlotGrid grid={grid} side={SIDE} />

            {bins.map((bin, index) => (
              <rect
                key={index}
                data-testid="bin"
                className={styles.bin}
                x={index * width}
                y={SIDE - (bin.count / tallest) * SIDE}
                width={width}
                height={(bin.count / tallest) * SIDE}
                fill={colour ?? 'currentColor'}
                onPointerEnter={() => setHovered(index)}
                onPointerLeave={() => setHovered(null)}
              >
                <title>{`${short(bin.from)} to ${short(bin.to)}: ${bin.count}`}</title>
              </rect>
            ))}
          </svg>

          {hovered !== null && (
            <span
              className={styles.reading}
              data-testid="reading"
              style={{
                left: `${(hovered + 0.5) * width}%`,
                transform: hovered === 0 ? 'none' : hovered === bins.length - 1 ? 'translateX(-100%)' : 'translateX(-50%)',
              }}
            >
              {bins[hovered].count} × {short(bins[hovered].from)}–{short(bins[hovered].to)}
            </span>
          )}
        </div>

        {/* The value axis runs along the bottom here, so its ends are labelled where they are. */}
        <div className={styles.footScale} aria-hidden="true">
          <span>{short(summary.low)}</span>
          <span>{short(summary.high)}</span>
        </div>
      </div>
    </div>
  );
}

type Bin = { from: number; to: number; count: number };

/**
 * Bin width by Freedman–Diaconis, which takes the middle half of the readings rather than their
 * ends: one outlier should not decide how coarse the whole picture is.
 *
 * Whichever of it and Sturges' rule asks for more bars wins. Freedman–Diaconis is built around a
 * run with one hump in it, and under-bins a run with two — a sensor swinging between a high and
 * a low is exactly that, and four fat bars would hide the very thing worth seeing.
 */
function binsFor(values: number[], summary: Summary): Bin[] {
  const span = summary.high - summary.low;
  if (span === 0) return [{ from: summary.low, to: summary.high, count: values.length }];

  const iqr = summary.q3 - summary.q1;
  const width = iqr > 0 ? (2 * iqr) / Math.cbrt(summary.n) : 0;
  const count = Math.min(
    MOST_BINS,
    Math.max(
      FEWEST_BINS,
      width > 0 ? Math.ceil(span / width) : 0,
      Math.ceil(Math.log2(summary.n) + 1),
    ),
  );

  const bins: Bin[] = Array.from({ length: count }, (_, index) => ({
    from: summary.low + (span / count) * index,
    to: summary.low + (span / count) * (index + 1),
    count: 0,
  }));

  for (const value of values) {
    // The highest reading belongs to the last bin rather than to one past the end.
    const index = Math.min(Math.floor(((value - summary.low) / span) * count), count - 1);
    bins[index].count++;
  }

  return bins;
}
