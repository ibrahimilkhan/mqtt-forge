import { useState } from 'react';
import styles from './App.module.css';
import { HealthDot } from './components/HealthDot';
import { StatusReadout } from './components/StatusReadout';
import { BrokerPanel } from './features/connection/BrokerPanel';
import { useBrokerAddress, useConnectionState } from './api/useConnectionState';
import { WireLog } from './features/monitor/WireLog';
import { TopicTree } from './features/topics/TopicTree';
import { PANELS, type PanelId } from './features/panels';
import { PublishPanel } from './features/publish/PublishPanel';
import { SubscribePanel } from './features/subscribe/SubscribePanel';
import type { Hub } from './realtime/hub';
import { useHubBridge } from './realtime/useHubBridge';
import { useHubStatusStore } from './stores/hubStatusStore';

export function App({ hub }: { hub: Hub }) {
  useHubBridge(hub);

  // Connecting comes first; reopen from the menu once closed.
  const [openPanel, setOpenPanel] = useState<PanelId | null>('broker');

  const { state } = useConnectionState();
  const where = useBrokerAddress();
  const hubStatus = useHubStatusStore((s) => s.status);

  return (
    <>
      <div className={styles.bar}>
        <h1 className={styles.wordmark}>
          MQ<span>Faker</span>
        </h1>

        <nav className={styles.menu} aria-label="Panels">
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

        <div className={styles.readoutSlot}>
          <StatusReadout state={state} where={where} reconnecting={hubStatus === 'reconnecting'} />
        </div>
      </div>

      <div className={styles.layout} data-testid="layout" data-panel={openPanel ? 'open' : 'closed'}>
        {openPanel === 'broker' && <BrokerPanel onClose={() => setOpenPanel(null)} />}
        {openPanel === 'subscribe' && <SubscribePanel onClose={() => setOpenPanel(null)} />}
        {openPanel === 'publish' && <PublishPanel onClose={() => setOpenPanel(null)} />}
        <section className={styles.treePane}>
          <TopicTree />
        </section>
        <section className={styles.wire}>
          <WireLog />
        </section>
      </div>

      <HealthDot />
    </>
  );
}
