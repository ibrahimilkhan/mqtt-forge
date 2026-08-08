import { useState, type CSSProperties, type ReactNode } from 'react';
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

const START: Widths = { panel: 1 / 3, tree: 1 / 3, right: 1 / 3 };
const START_LOG = 0.6;

export function Workspace({ panel, tree, log, publish }: Props) {
  // Held as the row looks with a panel open, so closing and reopening one puts it back as it was.
  const [widths, setWidths] = useState<Widths>(START);
  const [logShare, setLogShare] = useState(START_LOG);

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
    '--log': `${(logShare * 100).toFixed(2)}fr`,
    '--publish': `${((1 - logShare) * 100).toFixed(2)}fr`,
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

      <div className={styles.right}>
        <div className={styles.pane}>{log}</div>
        <ResizeHandle
          axis="y"
          label="Log and publish boundary"
          value={logShare}
          min={MIN_SHARE}
          max={1 - MIN_SHARE}
          onChange={setLogShare}
        />
        <div className={styles.pane}>{publish}</div>
      </div>
    </div>
  );
}
