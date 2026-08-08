import { useState, type ReactNode } from 'react';
import styles from './App.module.css';
import { HealthDot } from './components/HealthDot';
import { StatusReadout } from './components/StatusReadout';
import { AppearancePanel } from './features/appearance/AppearancePanel';
import { BrokerPanel } from './features/connection/BrokerPanel';
import { MobilePanel } from './features/mobile/MobilePanel';
import { useBrokerAddress, useConnectionState } from './api/useConnectionState';
import { WireLog } from './features/monitor/WireLog';
import { TopicTree } from './features/topics/TopicTree';
import { PANELS, type PanelId } from './features/panels';
import { useProseSelection } from './lib/useProseSelection';
import { PublishPanel } from './features/publish/PublishPanel';
import { SubscribePanel } from './features/subscribe/SubscribePanel';
import { Workspace } from './features/workspace/Workspace';
import type { Hub } from './realtime/hub';
import { useHubBridge } from './realtime/useHubBridge';
import { useHubStatusStore } from './stores/hubStatusStore';

const PANEL_VIEWS: Record<PanelId, (props: { onClose: () => void }) => ReactNode> = {
  broker: BrokerPanel,
  subscribe: SubscribePanel,
  mobile: MobilePanel,
  settings: AppearancePanel,
};

export function App({ hub }: { hub: Hub }) {
  useHubBridge(hub);
  useProseSelection();

  // Connecting comes first; reopen from the menu once closed.
  const [openPanel, setOpenPanel] = useState<PanelId | null>('broker');
  const [menuOpen, setMenuOpen] = useState(true);

  const { state } = useConnectionState();
  const where = useBrokerAddress();
  const hubStatus = useHubStatusStore((s) => s.status);

  const close = () => setOpenPanel(null);
  const Panel = openPanel && PANEL_VIEWS[openPanel];

  return (
    <>
      <div className={styles.bar}>
        <button
          type="button"
          className={styles.menuToggle}
          aria-expanded={menuOpen}
          aria-controls="panel-menu"
          aria-label="Panel menu"
          onClick={() => setMenuOpen((open) => !open)}
        >
          ☰
        </button>

        <h1 className={styles.wordmark}>
          MQ<span>Faker</span>
        </h1>

        <div className={styles.readoutSlot}>
          <StatusReadout state={state} where={where} reconnecting={hubStatus === 'reconnecting'} />
        </div>
      </div>

      <div className={styles.body}>
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

        <Workspace
          panel={Panel ? <Panel onClose={close} /> : undefined}
          tree={
            <section className={styles.treePane}>
              <TopicTree />
            </section>
          }
          log={
            <section className={styles.wire}>
              <WireLog />
            </section>
          }
          publish={<PublishPanel />}
        />
      </div>

      <HealthDot />
    </>
  );
}
