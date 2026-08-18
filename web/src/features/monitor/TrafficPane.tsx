import { TrafficChart } from './TrafficChart';
import { useTraffic } from './useTraffic';

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

  return (
    <>
      <h2 className="srOnly">Chart</h2>

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
