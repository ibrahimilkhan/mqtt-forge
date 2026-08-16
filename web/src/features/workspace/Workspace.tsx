import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { MIN_SHARE, ResizeHandle } from './ResizeHandle';
import styles from './Workspace.module.css';

type Props = {
  /** Column one. Absent when no panel is open, and its width is shared out between the other two. */
  panel?: ReactNode;
  tree: ReactNode;
  log: ReactNode;
  publish: ReactNode;
};

type Widths = { panel: number; tree: number; right: number };

// The topics column is the one that has to hold a shape rather than a line of text: a deep tree
// indents every level, so it starts as the widest of the three. The panel column holds a form
// and reads fine narrow; the log wraps a long topic onto a second line and carries on.
const START: Widths = { panel: 0.24, tree: 0.44, right: 0.32 };

/**
 * Where to put the log/publish boundary so the publish form opens at exactly its own height.
 * Null while the column has no measured height — there is nothing to divide yet.
 */
export function fitShare(columnHeight: number, publishHeight: number): number | null {
  if (columnHeight <= 0) return null;

  const share = 1 - publishHeight / columnHeight;
  return Math.min(1 - MIN_SHARE, Math.max(MIN_SHARE, share));
}

export function Workspace({ panel, tree, log, publish }: Props) {
  // Held as the row looks with a panel open, so closing and reopening one puts it back as it was.
  const [widths, setWidths] = useState<Widths>(START);

  // Null until measured: the column sizes the publish pane to its content, so the form fits on
  // first paint whatever the window height, instead of being clipped by a guessed fraction.
  const [logShare, setLogShare] = useState<number | null>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const publishRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (logShare !== null) return;

    const column = columnRef.current;
    const pane = publishRef.current;
    if (!column || !pane) return;

    // scrollHeight, not clientHeight: content-sized now, but this still reads the full form
    // if anything has already clipped it.
    const measured = fitShare(column.clientHeight, pane.scrollHeight);
    if (measured !== null) setLogShare(measured);
  }, [logShare]);

  // A closed panel hands half its width to each neighbour, rather than to whichever is wider.
  const spare = panel ? 0 : widths.panel / 2;
  const shown = {
    panel: panel ? widths.panel : 0,
    tree: widths.tree + spare,
    right: widths.right + spare,
  };

  const columns = {
    '--panel': `${(shown.panel * 100).toFixed(2)}fr`,
    '--tree': `${(shown.tree * 100).toFixed(2)}fr`,
    '--right': `${(shown.right * 100).toFixed(2)}fr`,
    '--log': `${((logShare ?? 0) * 100).toFixed(2)}fr`,
    '--publish': `${((1 - (logShare ?? 0)) * 100).toFixed(2)}fr`,
  } as CSSProperties;

  // Both side-by-side handles report where their boundary sits across the whole row, which is what
  // the pointer can measure; the widths either side follow from it.
  const movePanelEdge = (edge: number) =>
    setWidths({ ...widths, panel: edge, tree: widths.panel + widths.tree - edge });

  const moveTreeEdge = (edge: number) =>
    setWidths({ ...widths, tree: edge - shown.panel - spare, right: 1 - edge - spare });

  return (
    <div
      className={styles.grid}
      data-testid="layout"
      data-panel={panel ? 'open' : 'closed'}
      style={columns}
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

      <div
        ref={columnRef}
        className={styles.right}
        data-testid="right-column"
        data-fit={logShare === null ? 'content' : 'split'}
      >
        <div className={styles.pane}>{log}</div>
        <ResizeHandle
          axis="y"
          label="Log and publish boundary"
          value={logShare ?? 0.6}
          min={MIN_SHARE}
          max={1 - MIN_SHARE}
          onChange={setLogShare}
        />
        <div ref={publishRef} className={styles.pane}>
          {publish}
        </div>
      </div>
    </div>
  );
}
