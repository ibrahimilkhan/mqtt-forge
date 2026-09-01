// @ts-nocheck
/**
 * Not a test — a renderer, in the same spirit as gallery.render.test.tsx and alerts.render.test.tsx.
 *
 * The reconnect block cannot be driven to its interesting states in a browser without a broker
 * that will drop on cue: a ladder mid-climb with a countdown on it, an outage somebody stopped, a
 * link that went and came back. Here they are built out of store and cache state directly and
 * rendered through the real BrokerPanel, so what it writes is what the console draws.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import { it } from 'vitest';
import './styles/global.css';
import { queryKeys } from './api/queryKeys';
import { BrokerPanel } from './features/connection/BrokerPanel';
import { ReconnectNotice } from './features/connection/ReconnectNotice';
import { arrived } from './features/connection/reconnectView';
import { resetLinkWatch, useLinkWatchStore } from './stores/linkWatchStore';

const OUT = '/Users/ilkhan/RiderProjects/MqttForge/src/MqttForge.Api/wwwroot';

const STYLE = `<style>
  body { padding: 24px; background: var(--paper); }
  h2 { font-family: var(--mono); font-size: var(--t-small); letter-spacing: .12em;
       text-transform: uppercase; color: var(--muted); margin: 26px 0 10px; }
  .plate { background: var(--surface); border-radius: var(--r-plate); padding: 16px 18px;
           max-width: 760px; }
  nav a { font-family: var(--mono); font-size: var(--t-small); margin-right: 14px; }
</style>`;

const NAV = ['reconnect-working', 'reconnect-stopped', 'reconnect-off', 'reconnect-back', 'reconnect-quiet', 'reconnect-panel']
  .map((name) => `<a href="/${name}.html">${name}</a>`)
  .join('');

const page = (title, inner) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>MQTTForge — ${title}</title>
${document.head.innerHTML}
${STYLE}
</head><body><nav>${NAV}</nav>${inner}</body></html>`;

const FAILURE = {
  reason: 'brokerClosed',
  host: 'broker.plant.local',
  port: 8883,
  clientId: 'mqttforge-console',
  useTls: true,
  transport: 'tcp',
  protocolVersion: 'v500',
};

/** A cache primed the way a console mid-outage actually holds one. */
function client(state, status) {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  query.setQueryData(queryKeys.connection, {
    state,
    failure: state === 'Faulted' ? FAILURE : null,
    connection:
      state === 'Connected'
        ? {
            host: FAILURE.host, port: FAILURE.port, clientId: FAILURE.clientId,
            username: 'plant', useTls: true, connectedAt: '2026-09-02T20:59:26Z',
            sessionPresent: false, assignedClientId: null, serverKeepAlive: 60,
            transport: 'tcp', protocolVersion: 'v500',
          }
        : null,
  });

  // Through `arrived`, exactly as both real paths do — so the countdown on the page is drawn from
  // a deadline on this machine's clock, which is what makes 8s read as 8s.
  query.setQueryData(
    queryKeys.reconnect,
    arrived({
      enabled: true, active: false, attempt: 0, nextAttemptAt: null, gaveUp: false,
      now: '2026-09-02T21:00:00.000Z',
      ...status,
    }),
  );

  query.setQueryData(queryKeys.savedSettings, null);
  query.setQueryData(queryKeys.savedProfiles, []);
  query.setQueryData(queryKeys.certificateDialog, { canChoose: false });

  return query;
}

/** The link history the notice reads: up, then gone, and sometimes back. */
function history({ back = false } = {}) {
  resetLinkWatch();
  const watch = useLinkWatchStore.getState();
  act(() => {
    watch.saw('Connected', null, 0);
    watch.saw('Faulted', FAILURE, 1_000);
    if (back) watch.saw('Connected', null, 35_000);
  });
}

const block = (query) =>
  render(
    <QueryClientProvider client={query}>
      <div className="plate">
        <ReconnectNotice />
      </div>
    </QueryClientProvider>,
  );

it.skipIf(!existsSync(OUT))('writes the reconnect pages', () => {
  // 1 — the ladder mid-climb, which is the state the whole feature was asked for.
  history();
  let view = block(
    client('Faulted', {
      active: true,
      attempt: 3,
      // Eight seconds after the server's 'now', which is the fourth rung.
      nextAttemptAt: '2026-09-02T21:00:08.000Z',
    }),
  );
  writeFileSync(`${OUT}/reconnect-working.html`, page('reconnecting', view.container.innerHTML));
  view.unmount();

  // 2 — the same outage, called off by hand.
  history();
  view = block(client('Faulted', { active: false, gaveUp: true, attempt: 4 }));
  writeFileSync(`${OUT}/reconnect-stopped.html`, page('stopped', view.container.innerHTML));
  view.unmount();

  // 3 — and the other reason nothing is being tried, which is a different sentence because it is
  // undone by a different control.
  history();
  view = block(client('Faulted', { enabled: false, active: false }));
  writeFileSync(`${OUT}/reconnect-off.html`, page('auto-reconnect off', view.container.innerHTML));
  view.unmount();

  // 4 — it came back, and the panel stayed to say so.
  history({ back: true });
  view = block(client('Connected', {}));
  writeFileSync(`${OUT}/reconnect-back.html`, page('reconnected', view.container.innerHTML));
  view.unmount();

  // 5 — nothing wrong: the switch on its own, which is the panel opened on purpose.
  resetLinkWatch();
  act(() => useLinkWatchStore.getState().saw('Connected', null, 0));
  view = block(client('Connected', {}));
  writeFileSync(`${OUT}/reconnect-quiet.html`, page('nothing wrong', view.container.innerHTML));
  view.unmount();

  // 6 — and the whole panel with the block on top of it, which is the only page that shows
  // whether it sits right above the form it was put in front of.
  history();
  const query = client('Faulted', {
    active: true,
    attempt: 2,
    nextAttemptAt: '2026-09-02T21:00:16.000Z',
  });
  view = render(
    <QueryClientProvider client={query}>
      <div className="plate" style={{ maxWidth: 900 }}>
        <BrokerPanel onClose={() => {}} open={() => {}} />
      </div>
    </QueryClientProvider>,
  );
  writeFileSync(`${OUT}/reconnect-panel.html`, page('the panel a fault opened', view.container.innerHTML));
  view.unmount();
});
