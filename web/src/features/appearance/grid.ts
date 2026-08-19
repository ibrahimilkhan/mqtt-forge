/**
 * What is drawn round and behind the line.
 *
 * The plot started with no frame at all, on the argument that the line is the only ink a chart
 * needs. That holds for a sparkline in a table; it stops holding the moment the plot is the size
 * of a pane and carries an axis, a mean, a threshold and a scale — without an edge, none of those
 * has anything to be measured against, and the reader cannot see where the plot's own range ends.
 */
export const GRIDS = {
  none: { label: 'None — the line alone', frame: false, lines: false },
  frame: { label: 'Frame — a rule round the plot', frame: true, lines: false },
  lines: { label: 'Frame and gridlines — the quarters marked', frame: true, lines: true },
} as const;

export type GridId = keyof typeof GRIDS;

export const GRID_DEFAULT: GridId = 'frame';

/** Where the gridlines fall, as fractions across and down the plot. Quarters: halves are too few
 *  to read a height off, and eighths are a mesh the line has to be picked out of. */
export const QUARTERS = [0.25, 0.5, 0.75] as const;
