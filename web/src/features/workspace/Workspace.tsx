import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
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

export type RegionId = keyof Rows;

/** Top to bottom, which is the order they are drawn and the order they are named in. */
const REGIONS: ReadonlyArray<{ id: RegionId; label: string }> = [
  { id: 'log', label: 'Log' },
  { id: 'chart', label: 'Chart' },
  { id: 'publish', label: 'Publish' },
];

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

  // Which of the three the reader has folded away. A region shut gives its height to the two
  // above and below it, which is how the chart gets a whole column on a laptop: the newest
  // reading is already at the top of the log's own pane, and the publish form is not being
  // filled in while a run is being read.
  const [shut, setShut] = useState<ReadonlyArray<RegionId>>([]);

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

  const open = (id: RegionId) => !shut.includes(id);
  // A shut region takes no share, and the two either side of it divide what it gave up in the
  // proportion they already stood in.
  const weight = (id: RegionId) => (open(id) ? split[id] : 0);
  const spread = weight('log') + weight('chart') + weight('publish');

  const tracks = {
    '--panel': `${(shown.panel * 100).toFixed(2)}fr`,
    '--tree': `${(shown.tree * 100).toFixed(2)}fr`,
    '--right': `${(shown.right * 100).toFixed(2)}fr`,
    '--log': `${(split.log * 100).toFixed(2)}fr`,
    '--chart': `${(split.chart * 100).toFixed(2)}fr`,
    '--publish': `${(split.publish * 100).toFixed(2)}fr`,
    // Written out rather than composed from the three vars above: a shut region is not a small
    // share of the height, it is a header and nothing else, and no fraction expresses that.
    ...(rows !== null || shut.length > 0
      ? { gridTemplateRows: REGIONS.map(({ id }) => track(open(id), weight(id) / spread)).join(' auto ') }
      : {}),
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

  // The last one standing cannot be folded: a column of three shut headers is a column with
  // nothing in it, and nothing in the workspace would say what to do about that.
  const alone = shut.length === REGIONS.length - 1;

  const fold = (id: RegionId) =>
    setShut((closed) => (closed.includes(id) ? closed.filter((one) => one !== id) : [...closed, id]));

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
          and the form that answers back. Only the boundaries move — and each region folds to its
          own header when a reader wants the column spent on one of the other two. */}
      <div
        ref={columnRef}
        className={styles.right}
        data-testid="right-column"
        data-fit={rows === null ? 'content' : 'split'}
      >
        <Region id="log" label="Log" open={open('log')} alone={alone} onFold={fold} innerRef={logRef}>
          {log}
        </Region>
        <ResizeHandle
          axis="y"
          label="Log and chart boundary"
          value={split.log}
          min={MIN_SHARE}
          max={split.log + split.chart - MIN_SHARE}
          onChange={moveLogEdge}
          off={!open('log') || !open('chart')}
        />
        <Region id="chart" label="Chart" open={open('chart')} alone={alone} onFold={fold}>
          {chart}
        </Region>
        <ResizeHandle
          axis="y"
          label="Chart and publish boundary"
          value={split.log + split.chart}
          min={split.log + MIN_SHARE}
          max={1 - MIN_SHARE}
          onChange={moveChartEdge}
          off={!open('chart') || !open('publish')}
        />
        <Region
          id="publish"
          label="Publish"
          open={open('publish')}
          alone={alone}
          onFold={fold}
          innerRef={publishRef}
        >
          {publish}
        </Region>
      </div>
    </div>
  );
}

/** A region's track: its share of what the open ones are dividing, or just its own header. */
const track = (open: boolean, share: number) =>
  open ? `minmax(0, ${(share * 100).toFixed(2)}fr)` : 'min-content';

/**
 * One of the right column's three places, with the strip that folds it away.
 *
 * The strip is the price: three of them cost about as much height as the bar that used to run
 * across the top of the console. What it buys is that any one of the three can have nearly the
 * whole column — which on a laptop is the difference between a chart four readings tall and one
 * a run can actually be read off.
 */
function Region({
  id,
  label,
  open,
  alone,
  onFold,
  innerRef,
  children,
}: {
  id: RegionId;
  label: string;
  open: boolean;
  /** Folding this one would leave the column empty, so the control says so rather than doing it. */
  alone: boolean;
  onFold: (id: RegionId) => void;
  innerRef?: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  const locked = open && alone;

  return (
    <div ref={innerRef} className={styles.region} data-region={id} data-open={open ? '' : undefined}>
      <button
        type="button"
        className={styles.regionHead}
        aria-expanded={open}
        aria-controls={`region-${id}`}
        disabled={locked}
        // Named for what it does rather than for what it says: the strip reads 'Chart', and a
        // control called 'Chart' tells a listener nothing about which way it is about to go.
        aria-label={
          locked ? `${label} — the last region open` : `${open ? 'Fold' : 'Open'} ${label}`
        }
        title={locked ? 'The last region open — fold another one first' : `${open ? 'Fold' : 'Open'} ${label}`}
        onClick={() => onFold(id)}
      >
        <span className={styles.regionChevron} aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className={styles.regionLabel}>{label}</span>
      </button>

      {/* Unmounted rather than hidden: a folded log is a list of a thousand rows that no longer
          has to be laid out on every arrival. */}
      {open && (
        <div id={`region-${id}`} className={styles.pane}>
          {children}
        </div>
      )}
    </div>
  );
}
