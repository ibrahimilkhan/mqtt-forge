// @ts-nocheck
/**
 * Not a test — a renderer, in the same spirit as reconnect.render.test.tsx.
 *
 * The broker panel has six states to say and a browser can be driven to two of them. The other
 * four need a broker that drops on cue, a server that goes while the page stays open, or a dial
 * caught in flight. Here they are built out of cache and store state directly and drawn through
 * the real panel, so what this writes is what the console draws.
 *
 * One page, all six, so the run of them can be read down a column — which is the only way to see
 * whether they are one family of states or six separate decisions.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import { it } from 'vitest';
import './styles/global.css';
import { queryKeys } from './api/queryKeys';
import { BrokerPanel } from './features/connection/BrokerPanel';
import { arrived } from './features/connection/reconnectView';
import { resetLinkWatch, useLinkWatchStore } from './stores/linkWatchStore';
import { useHubStatusStore } from './stores/hubStatusStore';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '../../src/MqttForge.Api/wwwroot');

const STYLE = `<style>
  body { padding: 24px; background: var(--paper); }
  h2 { font-family: var(--mono); font-size: var(--t-small); letter-spacing: .12em;
       text-transform: uppercase; color: var(--muted); margin: 30px 0 8px; }
  h2 span { text-transform: none; letter-spacing: .02em; color: var(--muted); }
  .plate { background: var(--paper); border-radius: var(--r-plate); max-width: 900px;
           box-shadow: 0 0 0 1px var(--rule); }
</style>`;

const page = (title, inner) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>MQTTForge — ${title}</title>
${document.head.innerHTML}
${STYLE}
</head><body>${inner}</body></html>`;

const LINK = {
  host: 'broker.plant.local',
  port: 8883,
  clientId: 'mqttforge-console',
  username: 'plant',
  useTls: true,
  connectedAt: '2026-09-11T20:59:26Z',
  sessionPresent: false,
  assignedClientId: null,
  serverKeepAlive: 60,
  transport: 'tcp',
  protocolVersion: 'v500',
};

const FAILURE = {
  reason: 'brokerClosed',
  host: LINK.host,
  port: LINK.port,
  clientId: LINK.clientId,
  useTls: true,
  transport: 'tcp',
  protocolVersion: 'v500',
};

function client(state, reconnect = {}) {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  query.setQueryData(queryKeys.connection, {
    state,
    failure: state === 'Faulted' ? FAILURE : null,
    connection: state === 'Connected' ? LINK : null,
  });
  query.setQueryData(
    queryKeys.reconnect,
    arrived({
      enabled: true,
      active: false,
      attempt: 0,
      nextAttemptAt: null,
      gaveUp: false,
      now: '2026-09-11T21:00:00.000Z',
      ...reconnect,
    }),
  );
  query.setQueryData(queryKeys.savedSettings, null);
  query.setQueryData(queryKeys.savedProfiles, []);
  query.setQueryData(queryKeys.certificateDialog, { canChoose: false });

  return query;
}

const panel = (query) =>
  render(
    <QueryClientProvider client={query}>
      <div className="plate">
        <BrokerPanel onClose={() => {}} open={() => {}} />
      </div>
    </QueryClientProvider>,
  );

// Renderers mount the real panel six times over; thirty seconds costs nothing and five is not
// always enough on a box running both test projects at once.
const PATIENCE = 60_000;

const CASES = [
  ['Disconnected', 'nobody has asked for a link yet', 'Disconnected', {}, 'live'],
  ['Waiting', 'a connect in flight', 'Connecting', {}, 'live'],
  ['Faulted', 'down, and nothing being done about it', 'Faulted', {}, 'live'],
  [
    'Retrying',
    'down, and the ladder climbing back',
    'Faulted',
    { active: true, attempt: 3, nextAttemptAt: '2026-09-11T21:00:08.000Z' },
    'live',
  ],
  ['Connected', 'there is a link', 'Connected', {}, 'live'],
  ['Reconnecting', 'the console has lost its own server', 'Connected', {}, 'reconnecting'],
];

it.skipIf(!existsSync(OUT))('writes the six states of the broker panel', () => {
  const parts = [];

  for (const [name, gloss, state, reconnect, hub] of CASES) {
    resetLinkWatch();
    if (state === 'Connected') act(() => useLinkWatchStore.getState().saw('Connected', null, 0));
    act(() => useHubStatusStore.getState().setStatus(hub));

    const view = panel(client(state, reconnect));
    parts.push(`<h2>${name} <span>— ${gloss}</span></h2>${view.container.innerHTML}`);
    view.unmount();
  }

  act(() => useHubStatusStore.getState().setStatus('live'));
  writeFileSync(`${OUT}/broker-states.html`, page('every state the panel says', parts.join('\n')));
}, PATIENCE);
