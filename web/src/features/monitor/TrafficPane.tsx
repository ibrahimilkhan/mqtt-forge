import floating from './Floating.module.css';
import { useFloating } from './floating';
import { Pin } from './Pin';
import { TrafficChart } from './TrafficChart';
import styles from './TrafficChart.module.css';
import { useWindows } from './useWindows';
import { useTraffic } from './useTraffic';
import { useEscapeFromZoom, useZoomStore } from './useZoom';

/**
 * The middle of the right column: the shape of the run whose newest reading is above it.
 *
 * A fixed region rather than a block that grows out of the entries. The chart used to sit
 * between the newest row and the count, which meant it moved down the column whenever the row
 * above it grew a second line, and vanished from under the reader whenever a topic's bodies
 * stopped reading as numbers. Here it is always in the same place, and only what it draws
 * changes.
 */
export function TrafficPane() {
  const { selected, entries, runs, held } = useTraffic();
  const zoomed = useZoomStore((state) => state.zoomed);
  useEscapeFromZoom();

  return (
    <>
      <h2 className="srOnly">Chart</h2>

      {/* On the region rather than on the chart: the region is what grows, and it is still there
          — with something to say — when no topic has been picked and there is no chart at all. */}
      <Zoom />

      {/* Thrown open, the region is a window: it says what it is a chart of, it is moved by that
          line and sized by its corner, and the pin is where it stops following the selection and
          becomes one of several. Shut, none of that exists — the region is a third of a column
          and has neither the room for a bar nor anywhere to be moved to. */}
      {zoomed && <WindowBar label={selected?.label} filter={selected?.filter} />}

      {!selected && <p className="empty">The shape of a topic's readings is drawn here.</p>}

      {selected && entries.length === 0 && (
        <p className="empty">Nothing on {selected.label} to chart yet.</p>
      )}

      {/* Keyed like the entries above: a new selection is a new run, so the field being charted
          and the view it is drawn in start again rather than carrying over from another topic. */}
      {selected && entries.length > 0 && (
        <TrafficChart key={selected.filter} runs={runs} frozen={held} />
      )}
    </>
  );
}

/**
 * The bar the thrown-open chart is moved by, and the pin that opens a window on it.
 *
 * The pin takes a copy of this chart off the selection: the new window keeps the filter it was
 * opened on, the console underneath goes back to one chart in its column, and the reader can
 * pick a second topic and open that one beside it. Which is the whole point — two runs on screen at once, rather than one
 * run and the memory of another.
 */
function WindowBar({ label, filter }: { label?: string; filter?: string }) {
  const box = useZoomStore((state) => state.box);
  const place = useZoomStore((state) => state.place);
  const close = useZoomStore((state) => state.close);
  const open = useWindows((state) => state.open);
  const { bar, grip } = useFloating(box ?? { x: 0, y: 0, w: 0, h: 0 }, place);

  const keep = () => {
    if (!filter) return;
    // Where this chart is standing, so the window takes its place exactly rather than jumping
    // to the middle out from under the reader. It opens in the middle, so that is usually the
    // same answer — and when it is not, it is because the reader put it somewhere.
    open({ kind: 'chart', filter }, label ?? filter, box ?? undefined);
    // The window carries on where this one was, so leaving this one open would be the same
    // chart twice, one exactly over the other.
    close();
  };

  return (
    <>
      <div
        className={`${floating.bar} ${floating.overChart}`}
        {...bar}
        title="Drag to move — the corner sizes it"
      >
        <span className={floating.name}>{label ?? 'Chart'}</span>
        {filter && (
          <button
            type="button"
            className={floating.pin}
            aria-label={`Pin ${label ?? filter}`}
            title={`Pin ${label ?? filter} — it opens a window that keeps drawing this topic while the console moves on`}
            onClick={keep}
          >
            <Pin />
          </button>
        )}
      </div>

      <button
        type="button"
        className={floating.grip}
        aria-label="Resize the chart window"
        title="Drag to size"
        {...grip}
      />
    </>
  );
}

/**
 * The control that lifts the chart out of its column, in the corner it opens from.
 *
 * Its own element rather than a chip in the controls row: the row is absent at the plainest
 * detail level, and a bare line is exactly the drawing a reader most often wants more room for.
 * It sits over the top-right corner of the region, which is the corner it grows out of, and
 * stays there while it is open so the way back is where the way out was.
 */
function Zoom() {
  const zoomed = useZoomStore((state) => state.zoomed);
  const toggle = useZoomStore((state) => state.toggle);

  return (
    <button
      type="button"
      className={styles.zoom}
      data-testid="zoom"
      aria-pressed={zoomed}
      aria-label={zoomed ? 'Put the chart back' : 'Open the chart over the console'}
      title={zoomed ? 'Put the chart back — Escape' : 'Open the chart over the console'}
      onClick={toggle}
    >
      {/* Two corners of a box, pointing out or in: the same mark every viewer uses, and it needs
          no room for a word at the size this control has to be. */}
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
        {zoomed ? (
          <path
            d="M7 2v5H2M9 14V9h5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : (
          <path
            d="M10 2h4v4M6 14H2v-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
      </svg>
    </button>
  );
}
