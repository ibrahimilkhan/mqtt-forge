import { useEffect, type CSSProperties } from 'react';
import styles from './Floating.module.css';
import { moved, sized, useFloating } from './floating';
import { Pin } from './Pin';
import { TrafficChart } from './TrafficChart';
import { useChartWindows, type ChartWindow as Chart } from './useChartWindows';
import { useRunsFor } from './useTraffic';

/**
 * The chart windows a reader has opened, floating over the console.
 *
 * They are drawn here, at the top of the app, rather than anywhere near the pane they were
 * opened from: a window is placed against the viewport, and everything between the chart and the
 * viewport is a grid track holding a share of a height.
 */
export function ChartWindows() {
  const windows = useChartWindows((state) => state.windows);
  const place = useChartWindows((state) => state.place);

  // A window placed against one viewport and left there while the window got smaller can end up
  // with no bar on screen — and the bar is the only way to bring it back. Sizing and moving each
  // of them by nothing is enough: those are what clamp them. The size as well as the corner,
  // since a window wider than the viewport keeps its close and its grip off the far edge.
  useEffect(() => {
    const settle = () => {
      for (const chart of useChartWindows.getState().windows) {
        const box = moved(sized(chart.box, 0, 0), 0, 0);
        if (box.x !== chart.box.x || box.y !== chart.box.y || box.w !== chart.box.w || box.h !== chart.box.h) {
          place(chart.id, box);
        }
      }
    };

    window.addEventListener('resize', settle);

    return () => window.removeEventListener('resize', settle);
  }, [place]);

  return (
    <>
      {windows.map((chart, index) => (
        // The order they are held in is the order they stack, said out loud rather than left to
        // the order they happen to be drawn in: the newest is on top, and touching one brings it
        // up. Two windows opening in the same place is ordinary here, so which is in front is
        // not a detail that can be left to work itself out.
        <ChartFrame key={chart.id} chart={chart} depth={index} />
      ))}
    </>
  );
}

function ChartFrame({ chart, depth }: { chart: Chart; depth: number }) {
  const close = useChartWindows((state) => state.close);
  const place = useChartWindows((state) => state.place);
  const fix = useChartWindows((state) => state.fix);
  const raise = useChartWindows((state) => state.raise);
  // Runs, not one merged sequence: a pinned window redraws on every batch for as long as it is
  // open, and merging a branch of thousands of topics only for the chart to split it again was
  // what made a pinned window cost two thirds of a second at a time.
  const runs = useRunsFor(chart.filter);
  const { bar, grip } = useFloating(chart.box, (box) => place(chart.id, box));

  const where: CSSProperties = {
    left: chart.box.x,
    top: chart.box.y,
    width: chart.box.w,
    height: chart.box.h,
    zIndex: 22 + depth,
  };

  return (
    <section
      className={styles.window}
      style={where}
      data-testid="chart-window"
      data-filter={chart.filter}
      data-fixed={chart.fixed ? '' : undefined}
      aria-label={`${chart.label} chart`}
      // On the way down rather than on the click: a reader reaching for a control in a window
      // behind another one should have the window they are reaching into come forward first,
      // not after they have already pressed something on it. Focus counts as reaching in: a
      // reader tabbing into a window that is behind another one would otherwise be working a
      // window they cannot see.
      onPointerDownCapture={() => raise(chart.id)}
      onFocusCapture={() => raise(chart.id)}
    >
      <div
        className={styles.bar}
        // Pinned, the bar is a label with controls on it rather than a handle. The window still
        // comes forward when it is touched — it is being moved that the pin stops.
        {...(chart.fixed ? {} : bar)}
        // In the tab order only while it can do something, and named for what the arrow keys
        // will do with it once it is there.
        tabIndex={chart.fixed ? undefined : 0}
        role={chart.fixed ? undefined : 'application'}
        aria-label={chart.fixed ? undefined : `Move the ${chart.label} chart`}
        title={chart.fixed ? 'Pinned in place — unpin to move it' : 'Drag to move — the corner sizes it'}
      >
        {/* At the near end of the bar, not the far one. A window opens in the middle at the size
            the chart opens at, so the far end of this bar is exactly where the control that
            opened it was standing a moment ago — and a second press there, the one that asks
            'did that work?', would have landed on whatever is put in that corner. */}
        <button
          type="button"
          className={styles.pin}
          aria-pressed={chart.fixed}
          aria-label={chart.fixed ? `Let ${chart.label} move` : `Pin ${chart.label} in place`}
          title={
            chart.fixed
              ? `${chart.label} is pinned where it stands — unpin it to move or size it`
              : `Pin ${chart.label} where it stands`
          }
          onClick={() => fix(chart.id, !chart.fixed)}
        >
          <Pin />
        </button>

        <span className={styles.name}>{chart.label}</span>

        <button
          type="button"
          className={styles.close}
          aria-label={`Close the ${chart.label} chart`}
          title="Close this window"
          onClick={() => close(chart.id)}
        >
          ×
        </button>
      </div>

      <div className={styles.body}>
        {runs.length > 0 ? (
          // Keyed on the filter like the pane's own chart: this window only ever draws one, so
          // the key is really a statement that it never changes run under the reader.
          <TrafficChart key={chart.filter} runs={runs} />
        ) : (
          <p className="empty">Nothing on {chart.label} to chart yet.</p>
        )}
      </div>

      {/* Gone while it is pinned rather than shown and refusing: a corner that can be taken hold
          of and does nothing is a broken window, and the pin beside it says why it is not there. */}
      {!chart.fixed && (
        <button
          type="button"
          className={styles.grip}
          aria-label={`Resize the ${chart.label} chart`}
          title="Drag to size"
          {...grip}
        />
      )}
    </section>
  );
}
