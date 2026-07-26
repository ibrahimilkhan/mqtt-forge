import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { getConnectionState } from './api/connection';
import { queryKeys } from './api/queryKeys';
import styles from './App.module.css';
import { StatusReadout } from './components/StatusReadout';
import { BrokerPanel } from './features/connection/BrokerPanel';
import { WireLog } from './features/monitor/WireLog';
import { TopicTree } from './features/topics/TopicTree';
import { PANELS, type PanelId } from './features/panels';
import { PublishPanel } from './features/publish/PublishPanel';
import { SubscribePanel } from './features/subscribe/SubscribePanel';
import type { Hub } from './realtime/hub';
import { useHubBridge } from './realtime/useHubBridge';

export function App({ hub }: { hub: Hub }) {
  useHubBridge(hub);

  // Connecting comes first; the panel can be reopened from the menu once closed.
  const [openPanel, setOpenPanel] = useState<PanelId | null>('broker');

  const { data } = useQuery({ queryKey: queryKeys.connection, queryFn: getConnectionState });
  const state = data?.state ?? 'Disconnected';

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
          <StatusReadout state={state} />
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
    </>
  );
}
