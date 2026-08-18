import { useState, type ReactNode } from 'react';
import styles from './App.module.css';
import { StatusReadout } from './components/StatusReadout';
import { AppearancePanel } from './features/appearance/AppearancePanel';
import { MARKS, Wordmark } from './features/brand/marks';
import { ColoursPanel } from './features/colours/ColoursPanel';
import { BrokerPanel } from './features/connection/BrokerPanel';
import { MobilePanel } from './features/mobile/MobilePanel';
import { useBrokerAddress, useConnectionState } from './api/useConnectionState';
import { TrafficPane } from './features/monitor/TrafficPane';
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

const PANEL_VIEWS: Record<PanelId, (props: { onClose: () => void }) => ReactNode> = {
  broker: BrokerPanel,
  subscribe: SubscribePanel,
  colours: ColoursPanel,
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
  const [menuOpen, setMenuOpen] = useState(true);

  const { state } = useConnectionState();
  const where = useBrokerAddress();
  const hubStatus = useHubStatusStore((s) => s.status);
  const logo = useAppearanceStore((s) => s.logo);

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
          <section className={styles.chartPane}>
            <TrafficPane />
          </section>
        }
        publish={<PublishPanel />}
      />
    </div>
  );
}
