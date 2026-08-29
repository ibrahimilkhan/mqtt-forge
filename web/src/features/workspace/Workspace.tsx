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
  /**
   * A word beside the Log region's own name in its strip — its count, and the only thing the
   * strip says while the region is folded and the pane is gone.
   *
   * A node rather than a number: the workspace knows nothing about the log's contents and should
   * go on knowing nothing, so what is passed in subscribes for itself and an arrival re-renders
   * that and not the console around it.
   */
  logCount?: ReactNode;
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
  const log = clamp(logHeight / columnHeight, MIN_SHARE, CEILING);
  const publish = clamp(publishHeight / columnHeight, MIN_SHARE, 1 - MIN_SHARE - log);

  return { log, chart: 1 - log - publish, publish };
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/**
 * The most of the column one region may take, leaving the other two their floor.
 *
 * Named because it is two answers to one question: the height a region is clamped to, and the
 * height at which the column stops following the log's own content. A number that meant one and
 * not the other would let the log follow itself up to a size it is then cut back from.
 */
const CEILING = 1 - 2 * MIN_SHARE;

export function Workspace({ panel, wide = false, tree, log, logCount, chart, publish }: Props) {
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
  const chartRef = useRef<HTMLDivElement>(null);
  const publishRef = useRef<HTMLDivElement>(null);
  // By place, because everything below asks for a region by name and gets a box back. The chart
  // has one now only so a seam can measure the pair it divides; nothing ever fits the chart.
  const boxes: Record<RegionId, RefObject<HTMLDivElement | null>> = {
    log: logRef,
    chart: chartRef,
    publish: publishRef,
  };

  /**
   * The column follows the newest message until somebody asks it not to.
   *
   * Until this writes a split the column is content-sized — see `data-fit` below and the template
   * it turns on — and content-sized means the log's track is `min-content`: the region is exactly
   * as tall as the message in it, its heading, its padding and the line under it, and the chart
   * takes what is left. That is already the answer to 'size the log so the message fits'. It just
   * has to be allowed to go on being the answer.
   *
   * It was not. The split used to be fixed at the first change of the log's height, which is the
   * first message that ever lands — so the region was cut to the size of THAT message and every
   * later one was measured against it. A short reading followed by a JSON payload six lines deep
   * left the reader scrolling a region shaped for a number.
   *
   * So the split is fixed at the first moment the log stops resting, and not before:
   *
   *  - the reader opens the history, which is a request for more rows than any region could hold,
   *    and the pane's own 'N more below' is the answer to that rather than a taller region;
   *  - or the message at rest is taller than a region is allowed to be, and following it further
   *    would leave the chart and the form their floor and nothing else.
   *
   * Everything else is followed, in both directions: a quieter topic, a fault, a sentence, a
   * payload that grows and shrinks again. And any gesture that arranges the column — a drag, a
   * fold — writes a split of its own, which closes this for good: a reader who has arranged the
   * column owns it, and no message arriving afterwards may take that back.
   */
  useLayoutEffect(() => {
    if (rows !== null || typeof ResizeObserver === 'undefined') return;

    const column = columnRef.current;
    const top = logRef.current;
    const pane = publishRef.current;
    if (!column || !top || !pane) return;

    // The tallest the log has stood at while resting, which is what the column is divided at when
    // it finally is. Not the height in the report that ends the following: by then the list has
    // already been opened, and its rows arrive in the same commit as the marker leaving.
    let resting: number | null = null;

    const watch = new ResizeObserver(([entry]) => {
      const height = entry.contentRect.height;
      // The log marks the list it draws while it is showing one message and nothing else.
      const atRest = top.querySelector('[data-resting]') !== null;

      if (atRest) {
        resting = height;
        // Still a height a region may be, so the track is already following it.
        if (height <= column.clientHeight * CEILING) return;
      } else if (resting === null || height <= resting) {
        // No message has stood here yet, or the log got shorter — a quieter topic, a fault, a
        // folded log. Nothing to divide the column around, and the track follows it down.
        return;
      }

      const measured = fitRows(column.clientHeight, resting, pane.scrollHeight);
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

  /**
   * Where a boundary sits between the two it divides, or nothing to sit between.
   *
   * Measured in the shares the column is actually laid out in rather than the ones held in state,
   * which are two different things the moment a region is folded: a shut region keeps its share
   * in `rows`, waiting to be opened again, while the column divides itself between the ones left.
   * The floor is what turns on the difference — a pair sharing six tenths of the state and the
   * whole of the column was being told that a tenth of the column is a fifth of them, so with the
   * chart folded neither the log nor the form could be brought down to where they are allowed to
   * go. Divided through by what is open, the floor means the same fraction of the column in every
   * fold state, and means nothing at all when none of them are folded.
   */
  const seam = (above?: RegionId, below?: RegionId) =>
    above && below
      ? { ...between(split[above] / spread, split[below] / spread), off: false }
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

  /**
   * How tall a region would stand if it were exactly what is inside it, measured where it is.
   *
   * Nothing in the DOM will answer this on its own. `scrollHeight` floors at the box it is read
   * from, so it says 'the size you already are' every time the true answer is smaller — which is
   * every time a reader asks for a region to be made shorter. And the region itself is
   * `overflow: hidden` and never scrolls at all, so its own scrollHeight is its clientHeight in
   * every regime the column has.
   *
   * So the column is asked instead, in the one language it answers questions about height in: the
   * measured region's track is written `min-content` for the length of a single read, the other
   * two left as the fractions they already were, and the region's height read back. It is the
   * same question the stylesheet asks while the column is still sizing itself to its contents,
   * put to one track rather than to both ends at once.
   *
   * The template is back before the frame ends, so nothing is ever painted at the probe's sizes.
   * What would otherwise survive it is where the panes were scrolled to: a track that changes
   * height clamps the scroller inside it, and the measured pane exactly fits its contents while
   * it is being measured, which pins it to the top. All three are put back.
   */
  const contentHeight = (id: RegionId): number => {
    const column = columnRef.current;
    const region = boxes[id].current;
    if (!column || !region) return 0;

    const panes = REGIONS.map((one) => column.querySelector<HTMLElement>(`#region-${one.id}`));
    const scrolled = panes.map((pane) => pane?.scrollTop ?? 0);
    const held = column.style.gridTemplateRows;

    column.style.gridTemplateRows = REGIONS.map((one) =>
      one.id === id ? 'min-content' : track(open(one.id), weight(one.id) / spread),
    ).join(' auto ');

    const height = region.offsetHeight;

    column.style.gridTemplateRows = held;
    panes.forEach((pane, at) => {
      if (pane) pane.scrollTop = scrolled[at];
    });

    return height;
  };

  /**
   * Where a boundary has to sit for one named region to be exactly as tall as what is in it.
   *
   * Named by its place in the column rather than by whatever happens to lie against the seam at
   * this moment: the boundary under the log fits the log and the one over the form fits the form,
   * however many of the three are folded away — the same reasoning as the seams' own labels. The
   * chart is never the region fitted. It is the one that stretches, and a line has no height of
   * its own to snap to.
   *
   * Null wherever there is nothing to do. Chiefly while the column is still sizing itself to its
   * contents: both ends are already standing at exactly their own height there, so the gesture
   * would change nothing — and would spend the column's following of the log to do it, since any
   * split written down is a split the reader owns from then on.
   */
  const fitting =
    (id: RegionId) =>
    (above?: RegionId, below?: RegionId) =>
    (): number | null => {
      if (rows === null || !above || !below) return null;
      if (id !== above && id !== below) return null;

      const near = boxes[above].current;
      const far = boxes[below].current;
      if (!near || !far) return null;

      // The pair in pixels, against a want in pixels. Both regions are fractions of the same
      // leftover height, so a share of the pair means the same thing in either currency.
      const pair = near.offsetHeight + far.offsetHeight;
      const want = contentHeight(id);
      if (pair <= 0 || want <= 0) return null;

      return id === above ? want / pair : 1 - want / pair;
    };

  // The last one standing cannot be folded: a column of three shut headers is a column with
  // nothing in it, and nothing in the workspace would say what to do about that.
  const alone = shut.length === REGIONS.length - 1;

  const fold = (id: RegionId) => {
    // Folding turns the inline template on, and the template is written from `rows` — so a fold
    // taken before the column has a split of its own arranged it around the stand-in fractions
    // rather than around what is on screen. Harmless while the split was fixed within a second of
    // the first message; not harmless now that a column can follow the log for a whole session.
    // So the fold takes the split it can see, and owns it from there like a drag does.
    if (rows === null) setRows(measured());

    setShut((closed) => (closed.includes(id) ? closed.filter((one) => one !== id) : [...closed, id]));
  };

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

      {/* No fit on this boundary, nor on the panel's. A width would have to snap to the widest row
          the tree is holding, which is whichever topic arrived last and is gone again when that
          one is retired — a gesture that answers differently every minute is not one a reader can
          learn. The regions below have heights their contents actually settle at. */}
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
        <Region
          id="log"
          label="Log"
          count={logCount}
          open={open('log')}
          alone={alone}
          onFold={fold}
          innerRef={logRef}
        >
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
          fit={{ title: 'Fit the log', share: fitting('log')(logChart.above, logChart.below) }}
        />
        <Region
          id="chart"
          label="Chart"
          open={open('chart')}
          alone={alone}
          onFold={fold}
          innerRef={chartRef}
        >
          {chart}
        </Region>
        <ResizeHandle
          axis="y"
          label="Chart and publish boundary"
          {...seam(chartPublish.above, chartPublish.below)}
          onChange={move(chartPublish.above, chartPublish.below)}
          fit={{
            title: 'Fit the publish form',
            share: fitting('publish')(chartPublish.above, chartPublish.below),
          }}
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
  count,
  open,
  alone,
  onFold,
  innerRef,
  children,
}: {
  id: RegionId;
  label: string;
  /** Beside the name, for a region that has a count to give. */
  count?: ReactNode;
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
        {/* Outside the label rather than inside it: the label is the part that gets cut with an
            ellipsis when the column is narrow, and a count that could be cut is a count that can
            lie. */}
        {count !== undefined && <span className={styles.regionCount}>{count}</span>}
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
