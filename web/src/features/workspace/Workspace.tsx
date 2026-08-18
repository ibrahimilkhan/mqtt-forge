import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { MIN_SHARE, ResizeHandle } from './ResizeHandle';
import styles from './Workspace.module.css';

type Props = {
  /** Column one. Absent when no panel is open, and its width is shared out between the other two. */
  panel?: ReactNode;
  tree: ReactNode;
  log: ReactNode;
  chart: ReactNode;
  publish: ReactNode;
};

type Widths = { panel: number; tree: number; right: number };

/** The right column's three rows, top to bottom, as fractions of its height. */
export type Rows = { log: number; chart: number; publish: number };

// The topics column is the one that has to hold a shape rather than a line of text: a deep tree
// indents every level, so it starts as the widest of the three. The panel column holds a form
// and reads fine narrow; the log wraps a long topic onto a second line and carries on.
const START: Widths = { panel: 0.24, tree: 0.44, right: 0.32 };

/**
 * Where to put the two boundaries in the right column so the log and the publish form each open
 * at exactly their own height, and the chart takes what is left between them.
 *
 * Null while the column has no measured height — there is nothing to divide yet. The chart is
 * the one that stretches on purpose: the entries above it are one row until asked for more, and
 * the form below it is the size the form is, but a line has no natural height at all.
 */
export function fitRows(columnHeight: number, logHeight: number, publishHeight: number): Rows | null {
  if (columnHeight <= 0) return null;

  // Neither end may take so much that the other two are slivers, and the chart keeps its own
  // floor out of whatever the ends leave.
  const log = clamp(logHeight / columnHeight, MIN_SHARE, 1 - 2 * MIN_SHARE);
  const publish = clamp(publishHeight / columnHeight, MIN_SHARE, 1 - MIN_SHARE - log);

  return { log, chart: 1 - log - publish, publish };
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

export function Workspace({ panel, tree, log, chart, publish }: Props) {
  // Held as the row looks with a panel open, so closing and reopening one puts it back as it was.
  const [widths, setWidths] = useState<Widths>(START);

  // Null until measured: the column sizes the log and the publish pane to their content, so both
  // fit on first paint whatever the window height, instead of being clipped by a guessed
  // fraction.
  const [rows, setRows] = useState<Rows | null>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const publishRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (rows !== null) return;

    const column = columnRef.current;
    const top = logRef.current;
    const pane = publishRef.current;
    if (!column || !top || !pane) return;

    // scrollHeight, not clientHeight: content-sized now, but this still reads the full form
    // if anything has already clipped it.
    const measured = fitRows(column.clientHeight, top.scrollHeight, pane.scrollHeight);
    if (measured !== null) setRows(measured);
  }, [rows]);

  // A closed panel hands half its width to each neighbour, rather than to whichever is wider.
  const spare = panel ? 0 : widths.panel / 2;
  const shown = {
    panel: panel ? widths.panel : 0,
    tree: widths.tree + spare,
    right: widths.right + spare,
  };

  // Before the measurement the CSS sizes the rows itself, so the fractions here stand in only
  // for the handles' own arithmetic.
  const split = rows ?? { log: 0.3, chart: 0.4, publish: 0.3 };

  const tracks = {
    '--panel': `${(shown.panel * 100).toFixed(2)}fr`,
    '--tree': `${(shown.tree * 100).toFixed(2)}fr`,
    '--right': `${(shown.right * 100).toFixed(2)}fr`,
    '--log': `${(split.log * 100).toFixed(2)}fr`,
    '--chart': `${(split.chart * 100).toFixed(2)}fr`,
    '--publish': `${(split.publish * 100).toFixed(2)}fr`,
  } as CSSProperties;

  // Both side-by-side handles report where their boundary sits across the whole row, which is what
  // the pointer can measure; the widths either side follow from it.
  const movePanelEdge = (edge: number) =>
    setWidths({ ...widths, panel: edge, tree: widths.panel + widths.tree - edge });

  const moveTreeEdge = (edge: number) =>
    setWidths({ ...widths, tree: edge - shown.panel - spare, right: 1 - edge - spare });

  // The same arithmetic down the column: a boundary is measured against the whole of it, and the
  // two regions it divides take what falls either side. The third is untouched.
  const moveLogEdge = (edge: number) =>
    setRows({ ...split, log: edge, chart: split.log + split.chart - edge });

  const moveChartEdge = (edge: number) =>
    setRows({ ...split, chart: edge - split.log, publish: 1 - edge });

  return (
    <div
      className={styles.grid}
      data-testid="layout"
      data-panel={panel ? 'open' : 'closed'}
      style={tracks}
    >
      {panel && (
        <>
          <div className={styles.pane}>{panel}</div>
          <ResizeHandle
            axis="x"
            label="Panel and topics boundary"
            value={shown.panel}
            min={MIN_SHARE}
            max={widths.panel + widths.tree - MIN_SHARE}
            onChange={movePanelEdge}
          />
        </>
      )}

      <div className={styles.pane}>{tree}</div>

      <ResizeHandle
        axis="x"
        label="Topics and log boundary"
        value={shown.panel + shown.tree}
        min={shown.panel + spare + MIN_SHARE}
        max={1 - spare - MIN_SHARE}
        onChange={moveTreeEdge}
      />

      {/* Three fixed places, top to bottom: what arrived last, the shape of the run behind it,
          and the form that answers back. Only the boundaries move. */}
      <div
        ref={columnRef}
        className={styles.right}
        data-testid="right-column"
        data-fit={rows === null ? 'content' : 'split'}
      >
        <div ref={logRef} className={styles.pane}>
          {log}
        </div>
        <ResizeHandle
          axis="y"
          label="Log and chart boundary"
          value={split.log}
          min={MIN_SHARE}
          max={split.log + split.chart - MIN_SHARE}
          onChange={moveLogEdge}
        />
        <div className={styles.pane}>{chart}</div>
        <ResizeHandle
          axis="y"
          label="Chart and publish boundary"
          value={split.log + split.chart}
          min={split.log + MIN_SHARE}
          max={1 - MIN_SHARE}
          onChange={moveChartEdge}
        />
        <div ref={publishRef} className={styles.pane}>
          {publish}
        </div>
      </div>
    </div>
  );
}
