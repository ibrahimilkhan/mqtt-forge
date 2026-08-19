import { GRIDS, QUARTERS, type GridId } from '../appearance/grid';
import styles from './TrafficChart.module.css';

/**
 * The ground a plot is drawn on: its own edge, and optionally the quarters of it.
 *
 * The plot had neither, on the argument that the line is the only ink a chart needs. That holds
 * for a sparkline in a table. It stops holding at the size of a pane, where the plot carries a
 * scale, a mean, a threshold and readings pinned to its edges — a reader cannot tell a line lying
 * along the top of the plot from a line near the top without seeing where the top is.
 *
 * Drawn before everything else in the SVG, so the run is over the ground rather than under it,
 * and faint enough that it is read as ground: the eye should land on the line.
 */
export function PlotGrid({ grid, side }: { grid: GridId; side: number }) {
  const { frame, lines } = GRIDS[grid];
  if (!frame) return null;

  return (
    <g data-testid="plot-grid" data-grid={grid} aria-hidden="true">
      {lines &&
        QUARTERS.map((at) => (
          <line
            key={`across-${at}`}
            className={styles.gridLine}
            data-testid="gridline"
            x1={0}
            y1={side * at}
            x2={side}
            y2={side * at}
          />
        ))}
      {lines &&
        QUARTERS.map((at) => (
          <line
            key={`down-${at}`}
            className={styles.gridLine}
            data-testid="gridline"
            x1={side * at}
            y1={0}
            x2={side * at}
            y2={side}
          />
        ))}

      {/* Inset by half its own stroke on every side: a 1px rule centred on the viewBox's edge
          puts half of itself outside, and the SVG lets that overflow rather than clipping it —
          so an uninset frame reads as a hairline on two sides and a full rule on the other two. */}
      <rect
        className={styles.frameRule}
        data-testid="plot-frame"
        x={0}
        y={0}
        width={side}
        height={side}
        fill="none"
      />
    </g>
  );
}
