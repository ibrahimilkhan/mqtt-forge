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
  /**
   * Whether the open panel takes the whole workspace instead of a column of it.
   *
   * For the broker panel, which is read in one sitting and answered in one sitting: nothing in
   * the tree or the log means anything until the connection it describes is up. The other panels
   * are read against what is on screen — a filter against the tree it will narrow, a colour rule
   * against the branch it will paint — so they stay in their column.
   *
   * The other panes stay mounted underneath. A tree unmounted is a tree rebuilt from nothing the
   * next time the panel shuts, and the log would lose its history with it.
   */
  wide?: boolean;
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

export function Workspace({ panel, wide = false, tree, log, chart, publish }: Props) {
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

  // Fixed the first time the log's own height changes, which is when its first message lands —
  // not at mount, when the log is still showing the sentence asking the reader to pick a topic.
  // Taken then, the share was the height of that sentence, and the message that replaced it did
  // not fit: the count of what is behind it fell off the bottom of the region and had to be
  // scrolled to. Taken now, the region is the height of one message and the line under it.
  //
  // Only the first change. Every later one is the reader opening the history, and a log region
  // that grew to twenty-five rows would leave the chart its floor and nothing else.
  useLayoutEffect(() => {
    if (rows !== null || typeof ResizeObserver === 'undefined') return;

    const column = columnRef.current;
    const top = logRef.current;
    const pane = publishRef.current;
    if (!column || !top || !pane) return;

    let mounted: number | null = null;
    const watch = new ResizeObserver(([entry]) => {
      const height = entry.contentRect.height;

      // The observer reports the size it is already at before it reports a change.
      if (mounted === null) {
        mounted = height;

        return;
      }

      if (Math.abs(height - mounted) < 1) return;

      // scrollHeight, not clientHeight: content-sized now, but this still reads the full form
      // if anything has already clipped it.
      const measured = fitRows(column.clientHeight, top.scrollHeight, pane.scrollHeight);
      if (measured !== null) setRows(measured);
    });

    watch.observe(top);

    return () => watch.disconnect();
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
  } as CSSProperties;

  // The column's own template, written out rather than composed from the three vars above: a
  // shut region is not a small share of the height, it is a header and nothing else, and no
  // fraction expresses that. Left to the stylesheet until the column has been measured, so the
  // first paint still sizes the log and the form to their contents.
  const column: CSSProperties | undefined =
    rows !== null || shut.length > 0
      ? { gridTemplateRows: REGIONS.map(({ id }) => track(open(id), weight(id) / spread)).join(' auto ') }
      : undefined;

  // Every handle reports one number: where its boundary sits between the two panes it divides,
  // as a share of that pair. The pair keeps the room it had and only the line inside it moves,
  // so a seam never disturbs a third pane — and neither the seam nor this arithmetic has to know
  // what else is in the row, or whether any of it is folded away.
  const movePanelEdge = (share: number) => {
    const pair = widths.panel + widths.tree;
    setWidths({ ...widths, panel: share * pair, tree: (1 - share) * pair });
  };

  // Held as the row looks with a panel open, so what the reader dragged has the width a closed
  // panel lent its neighbours taken back off it before it is stored.
  const moveTreeEdge = (share: number) => {
    const pair = shown.tree + shown.right;
    setWidths({ ...widths, tree: share * pair - spare, right: (1 - share) * pair - spare });
  };

  /**
   * The two regions a boundary in the column actually divides.
   *
   * Not simply the ones either side of it. A folded region is a header and nothing else, so a
   * boundary drawn beside one divides whatever lies beyond it: fold the chart and the column is
   * the log, a strip, and the form, and BOTH of the column's boundaries divide the log from the
   * form. Which is what a reader grabbing either edge of that strip means — and until now neither
   * of them did anything, so folding the chart took away the only way to shorten the log or
   * lengthen the form.
   *
   * Undefined where there is nothing left with a height on that side, and then the boundary has
   * nothing to divide and says so.
   */
  const divides = (boundary: number) => ({
    above: [...REGIONS.slice(0, boundary + 1)].reverse().find(({ id }) => open(id))?.id,
    below: REGIONS.slice(boundary + 1).find(({ id }) => open(id))?.id,
  });

  /** Where a boundary sits between the two it divides, or nothing to sit between. */
  const seam = (above?: RegionId, below?: RegionId) =>
    above && below
      ? { ...between(split[above], split[below]), off: false }
      : { value: 0.5, min: 0, max: 1, off: true };

  /** Height out of one of them and into the other, leaving every other region where it was. */
  const move = (above?: RegionId, below?: RegionId) => (share: number) => {
    if (!above || !below) return;

    const now = measured();
    const pair = now[above] + now[below];
    setRows({ ...now, [above]: share * pair, [below]: (1 - share) * pair });
  };

  // What the column is actually divided into right now. Until the log has grown, that is not the
  // stand-in above: the column is sizing its two ends to their content, and the stand-in is only
  // there for the handles' arithmetic. Moving a boundary from where the stand-in says it is,
  // rather than from where the reader can see it, made the first drag of a session jump — the
  // log doubling in height because a seam three regions away was nudged. Read once, when that
  // first drag happens; after it the split is real and this answers with it.
  const measured = (): Rows => {
    const column = columnRef.current;
    if (rows !== null || shut.length > 0 || !column) return split;

    return (
      fitRows(
        column.clientHeight,
        logRef.current?.offsetHeight ?? 0,
        publishRef.current?.offsetHeight ?? 0,
      ) ?? split
    );
  };

  // The last one standing cannot be folded: a column of three shut headers is a column with
  // nothing in it, and nothing in the workspace would say what to do about that.
  const alone = shut.length === REGIONS.length - 1;

  const fold = (id: RegionId) =>
    setShut((closed) => (closed.includes(id) ? closed.filter((one) => one !== id) : [...closed, id]));

  const logChart = divides(0);
  const chartPublish = divides(1);

  return (
    <div
      className={styles.grid}
      data-testid="layout"
      data-panel={panel ? (wide ? 'full' : 'open') : 'closed'}
      style={tracks}
    >
      {panel && (
        <>
          <div className={styles.pane}>{panel}</div>
          {/* No boundary to drag when the panel is the whole of it. */}
          {!wide && (
            <ResizeHandle
              axis="x"
              label="Panel and topics boundary"
              {...between(widths.panel, widths.tree)}
              onChange={movePanelEdge}
            />
          )}
        </>
      )}

      <div className={styles.pane}>{tree}</div>

      <ResizeHandle
        axis="x"
        label="Topics and log boundary"
        {...between(shown.tree, shown.right)}
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
        style={column}
      >
        <Region id="log" label="Log" open={open('log')} alone={alone} onFold={fold} innerRef={logRef}>
          {log}
        </Region>
        {/* Named for its place in the column rather than for what it divides at this moment: the
            places are fixed and what they divide is not, and two boundaries that renamed
            themselves to the same pair when the chart folded would be two controls a reader
            cannot tell apart. What they divide right now is in the values. */}
        <ResizeHandle
          axis="y"
          label="Log and chart boundary"
          {...seam(logChart.above, logChart.below)}
          onChange={move(logChart.above, logChart.below)}
        />
        <Region id="chart" label="Chart" open={open('chart')} alone={alone} onFold={fold}>
          {chart}
        </Region>
        <ResizeHandle
          axis="y"
          label="Chart and publish boundary"
          {...seam(chartPublish.above, chartPublish.below)}
          onChange={move(chartPublish.above, chartPublish.below)}
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

/**
 * Where a seam sits between the two panes it divides, and how far along them it may travel.
 *
 * The floor is a share of the whole row or column, since that is what a pane is too narrow to be
 * useful at; scaled into the pair here, because that is the only space the seam itself works in.
 */
const between = (near: number, far: number) => {
  const pair = near + far;
  const floor = MIN_SHARE / pair;

  return { value: near / pair, min: floor, max: 1 - floor };
};

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
    <div
      ref={innerRef}
      className={styles.region}
      data-region={id}
      data-open={open ? '' : undefined}
      // For the seams either side of it: a folded region has no height to give, so a drag steps
      // over it to reach whatever does. See ResizeHandle's own measurement.
      data-folded={open ? undefined : ''}
    >
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
