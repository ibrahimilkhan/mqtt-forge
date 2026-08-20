import { useEffect, type CSSProperties } from 'react';
import styles from './Floating.module.css';
import { moved, useFloating } from './floating';
import { Pin } from './Pin';
import { TrafficChart } from './TrafficChart';
import { usePinnedStore, type PinnedChart as Chart } from './usePinned';
import { useRunFor } from './useTraffic';

/**
 * The charts a reader has pinned, floating over the console.
 *
 * They are drawn here, at the top of the app, rather than anywhere near the pane they were
 * pinned from: a window is placed against the viewport, and everything between the chart and the
 * viewport is a grid track holding a share of a height.
 */
export function PinnedCharts() {
  const pinned = usePinnedStore((state) => state.pinned);
  const place = usePinnedStore((state) => state.place);

  // A window placed against one viewport and left there while the window got smaller can end up
  // with no bar on screen — and the bar is the only way to bring it back. Moving each of them by
  // nothing is enough: the move is what clamps them.
  useEffect(() => {
    const settle = () => {
      for (const chart of usePinnedStore.getState().pinned) {
        const box = moved(chart.box, 0, 0);
        if (box.x !== chart.box.x || box.y !== chart.box.y) place(chart.id, box);
      }
    };

    window.addEventListener('resize', settle);

    return () => window.removeEventListener('resize', settle);
  }, [place]);

  return (
    <>
      {pinned.map((chart) => (
        <PinnedWindow key={chart.id} chart={chart} />
      ))}
    </>
  );
}

function PinnedWindow({ chart }: { chart: Chart }) {
  const unpin = usePinnedStore((state) => state.unpin);
  const place = usePinnedStore((state) => state.place);
  const raise = usePinnedStore((state) => state.raise);
  const entries = useRunFor(chart.filter);
  const { bar, grip } = useFloating(chart.box, (box) => place(chart.id, box));

  const where: CSSProperties = {
    left: chart.box.x,
    top: chart.box.y,
    width: chart.box.w,
    height: chart.box.h,
  };

  return (
    <section
      className={styles.window}
      style={where}
      data-testid="pinned-chart"
      data-filter={chart.filter}
      aria-label={`${chart.label} chart`}
      // On the way down rather than on the click: a reader reaching for a control in a window
      // behind another one should have the window they are reaching into come forward first,
      // not after they have already pressed something on it.
      onPointerDownCapture={() => raise(chart.id)}
    >
      <div className={styles.bar} {...bar} title="Drag to move — the corner sizes it">
        {/* At the near end of the bar, not the far one. In here the pin is not an action, it is
            the state — this chart is being kept — and the far end is where the pin that made
            this window was standing a moment ago. A second press there is the one that asks
            'did that work?', and it would have let the window straight back go. */}
        <button
          type="button"
          className={styles.pin}
          aria-pressed
          aria-label={`Unpin ${chart.label}`}
          title={`Unpin ${chart.label} — the window goes, the topic stays in the console`}
          onClick={() => unpin(chart.id)}
        >
          <Pin />
        </button>
        <span className={styles.name}>{chart.label}</span>
      </div>

      <div className={styles.body}>
        {entries.length > 0 ? (
          // Keyed on the filter like the pane's own chart: this window only ever draws one, so
          // the key is really a statement that it never changes run under the reader.
          <TrafficChart key={chart.filter} entries={entries} />
        ) : (
          <p className="empty">Nothing on {chart.label} to chart yet.</p>
        )}
      </div>

      <button
        type="button"
        className={styles.grip}
        aria-label={`Resize the ${chart.label} chart`}
        title="Drag to size"
        {...grip}
      />
    </section>
  );
}
