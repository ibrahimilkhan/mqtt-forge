import styles from './TrafficChart.module.css';

/**
 * The plot's own edge.
 *
 * It had none, on the argument that the line is the only ink a chart needs. That holds for a
 * sparkline in a table and stops holding at the size of a pane: with readings pinned to the
 * plot's edges and a scale beside it, a line lying along the top cannot be told from a line near
 * the top without seeing where the top is.
 *
 * Drawn before everything else in the SVG, so the run is over the ground rather than under it,
 * and faint enough to be read as ground — the eye should land on the line.
 *
 * It was briefly three settings: none, this, and this with the quarters marked. None undid the
 * thing it was added for and the quarters were decoration, so what is left is the one that was
 * always the answer.
 */
export function PlotGrid({ side }: { side: number }) {
  return (
    <rect
      className={styles.frameRule}
      data-testid="plot-frame"
      x={0}
      y={0}
      width={side}
      height={side}
      fill="none"
      aria-hidden="true"
    />
  );
}
