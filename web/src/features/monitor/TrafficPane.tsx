import { TrafficChart } from './TrafficChart';
import styles from './TrafficChart.module.css';
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
  const { selected, entries, held } = useTraffic();
  useEscapeFromZoom();

  return (
    <>
      <h2 className="srOnly">Chart</h2>

      {/* On the region rather than on the chart: the region is what grows, and it is still there
          — with something to say — when no topic has been picked and there is no chart at all. */}
      <Zoom />

      {!selected && <p className="empty">The shape of a topic's readings is drawn here.</p>}

      {selected && entries.length === 0 && (
        <p className="empty">Nothing on {selected.label} to chart yet.</p>
      )}

      {/* Keyed like the entries above: a new selection is a new run, so the field being charted
          and the view it is drawn in start again rather than carrying over from another topic. */}
      {selected && entries.length > 0 && (
        <TrafficChart key={selected.filter} entries={entries} frozen={held} />
      )}
    </>
  );
}

/**
 * The control that throws the chart open over the console, in the corner it opens from.
 *
 * Its own element rather than a chip in the controls row: the row is absent at the plainest
 * detail level, and a bare line is exactly the drawing a reader most often wants more room for.
 * It sits over the top-right corner of the chart, which is the corner it grows out of.
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
