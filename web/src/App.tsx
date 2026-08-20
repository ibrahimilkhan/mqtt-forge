import { useState, type ReactNode } from 'react';
import styles from './App.module.css';
import { StatusReadout } from './components/StatusReadout';
import { AppearancePanel } from './features/appearance/AppearancePanel';
import { MARKS, Wordmark } from './features/brand/marks';
import { ChartPanel } from './features/chart/ChartPanel';
import { ColoursPanel } from './features/colours/ColoursPanel';
import { BrokerPanel } from './features/connection/BrokerPanel';
import { MobilePanel } from './features/mobile/MobilePanel';
import { useBrokerAddress, useConnectionState } from './api/useConnectionState';
import { PinnedCharts } from './features/monitor/PinnedCharts';
import { TrafficPane } from './features/monitor/TrafficPane';
import { useZoomStore } from './features/monitor/useZoom';
import { WireLog } from './features/monitor/WireLog';
import { TopicTree } from './features/topics/TopicTree';
import { PANELS, type PanelId } from './features/panels';
import { useProseSelection } from './lib/useProseSelection';
import { PublishPanel } from './features/publish/PublishPanel';
import { SubscribePanel } from './features/subscribe/SubscribePanel';
import { Workspace } from './features/workspace/Workspace';
import type { Hub } from './realtime/hub';
import { useAppearanceStore } from './stores/appearanceStore';
import { useHubBridge } from './realtime/useHubBridge';
import { useHubStatusStore } from './stores/hubStatusStore';

/** The width the workspace stops being columns at, and the rail starts lying over it. */
const NARROW = '(max-width: 760px)';

const PANEL_VIEWS: Record<PanelId, (props: { onClose: () => void }) => ReactNode> = {
  broker: BrokerPanel,
  subscribe: SubscribePanel,
  colours: ColoursPanel,
  chart: ChartPanel,
  mobile: MobilePanel,
  settings: AppearancePanel,
};

/**
 * The whole console: a rail down the left, and the workspace taking everything else.
 *
 * There used to be a bar across the top carrying the name and the connection state. On a laptop
 * it cost sixty pixels of height for two facts that never move — and height is the scarce
 * dimension here, since every pane in the workspace is a list, a form or a plot that wants more
 * of it. Both facts sit in the rail now, which was already there and had room, and the rail
 * shuts to a strip when the reader wants the width instead.
 */
export function App({ hub }: { hub: Hub }) {
  useHubBridge(hub);
  useProseSelection();

  // Connecting comes first; reopen from the menu once closed.
  const [openPanel, setOpenPanel] = useState<PanelId | null>('broker');
  // Shut on a narrow screen, where the rail lies over the workspace rather than beside it: two
  // things covering the traffic before the reader has done anything is not an opening state.
  // Read once, on the first render — a reader who opens it should keep it open through a resize.
  const [menuOpen, setMenuOpen] = useState(() => !window.matchMedia?.(NARROW).matches);

  const { state } = useConnectionState();
  const where = useBrokerAddress();
  const hubStatus = useHubStatusStore((s) => s.status);
  const logo = useAppearanceStore((s) => s.logo);
  const zoomed = useZoomStore((s) => s.zoomed);
  const zoomBox = useZoomStore((s) => s.box);

  const close = () => setOpenPanel(null);
  const Panel = openPanel && PANEL_VIEWS[openPanel];

  return (
    <div className={styles.body}>
      {/* Never removed, only narrowed. With no bar above it, a rail that vanished would take the
          way back to itself with it. */}
      <div className={styles.rail} data-open={menuOpen ? '' : undefined}>
        <div className={styles.railHead}>
          <span className={styles.mark} aria-hidden="true">
            {MARKS[logo].draw()}
          </span>
          {menuOpen && (
            <h1 className={styles.wordmark}>
              <Wordmark />
            </h1>
          )}
          <button
            type="button"
            className={styles.railToggle}
            aria-expanded={menuOpen}
            aria-controls="panel-menu"
            aria-label="Panel menu"
            title={menuOpen ? 'Narrow the rail' : 'Open the rail'}
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? '‹' : '›'}
          </button>
        </div>

        {/* The one thing in the rail that changes. Shut, it is the lamp alone — which is all
            anyone reads it for from across a room. */}
        <div className={styles.railState}>
          <StatusReadout
            state={state}
            reconnecting={hubStatus === 'reconnecting'}
            compact={!menuOpen}
          />
          {menuOpen && where && (
            <p className={styles.where} title={where}>
              {where}
            </p>
          )}
        </div>

        {menuOpen && (
          <nav id="panel-menu" className={styles.menu} aria-label="Panels">
            {PANELS.map((panel) => (
              <button
                key={panel.id}
                type="button"
                className={styles.menuBtn}
                aria-expanded={openPanel === panel.id}
                onClick={() => setOpenPanel((current) => (current === panel.id ? null : panel.id))}
              >
                {panel.label}
              </button>
            ))}
          </nav>
        )}
      </div>

      <Workspace
        panel={Panel ? <Panel onClose={close} /> : undefined}
        tree={
          <section className={styles.treePane}>
            {/* The live link, so every topic hangs off the broker it actually came from. */}
            <TopicTree broker={where} />
          </section>
        }
        log={
          <section className={styles.wire}>
            <WireLog />
          </section>
        }
        chart={
          // Thrown open, the region leaves the column and takes the window. The strip that folds
          // it stays where it was, so the column does not rearrange itself underneath.
          <section
            className={styles.chartPane}
            data-zoomed={zoomed ? '' : undefined}
            // Where the reader put it. Inline because it is a place rather than a style: the
            // stylesheet says what a thrown-open chart looks like, and this says where this one
            // is standing right now.
            style={
              zoomed && zoomBox
                ? {
                    left: zoomBox.x,
                    top: zoomBox.y,
                    // The opening inset in the stylesheet sets all four sides; a placed window
                    // is two sides and a size, so the other two are given back.
                    right: 'auto',
                    bottom: 'auto',
                    width: zoomBox.w,
                    height: zoomBox.h,
                  }
                : undefined
            }
          >
            <TrafficPane />
          </section>
        }
        publish={<PublishPanel />}
      />

      {/* Over everything, and outside the workspace: a pinned chart is placed against the
          viewport, and every ancestor inside the workspace is a grid track with a share of a
          height. */}
      <PinnedCharts />
    </div>
  );
}
