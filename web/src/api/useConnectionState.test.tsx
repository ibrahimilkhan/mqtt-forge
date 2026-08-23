import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import { createFakeHub } from '../realtime/fakeHub';
import { useHubStatusStore } from '../stores/hubStatusStore';
import { server } from '../test/server';

// Store outlives a test; reset so one case's reconnect doesn't leak into the next.
beforeEach(() => useHubStatusStore.getState().setStatus('live'));

const LINK = {
  host: 'broker.example',
  port: 8883,
  clientId: 'c',
  username: null,
  useTls: true,
  connectedAt: '2026-08-08T12:00:00Z',
  sessionPresent: false,
  assignedClientId: null,
  serverKeepAlive: null,
};

function renderApp(state: string, connection: unknown = state === 'Connected' ? LINK : null) {
  const hub = createFakeHub();
  server.use(
    http.get('/api/connection', () => HttpResponse.json({ state, connection })),
    http.get('/api/connection/settings', () =>
      HttpResponse.json({
        host: 'broker.example',
        port: 8883,
        clientId: 'c',
        username: null,
        hasPassword: false,
        useTls: true,
        transport: 'tcp',
        protocolVersion: 'auto',
        webSocketPath: null,
        cleanSession: true,
        sessionExpiryInterval: null,
        tls: null,
      }),
    ),
  );

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <App hub={hub} />
    </QueryClientProvider>,
  );
  return hub;
}

// Menu and panel share button names, so scope each: menu by nav landmark, panel by label.
// Publish has a fixed place in the workspace; only Filters has to be opened first — and that
// panel is named for the filters it holds, while its button is still the verb.
async function openPanelButton(name: 'Subscribe' | 'Publish') {
  const panelName = name === 'Subscribe' ? 'Filters' : name;
  if (name === 'Subscribe') {
    const menu = screen.getByRole('navigation', { name: 'Panels' });
    await userEvent.click(within(menu).getByRole('button', { name: panelName }));
  }

  const panel = screen.getByRole('region', { name: `${panelName} panel` });
  return within(panel).getByRole('button', { name });
}

describe('connection gating', () => {
  it('disables Disconnect while there is no connection', async () => {
    renderApp('Disconnected');

    expect(await screen.findByRole('button', { name: 'Disconnect' })).toBeDisabled();
  });

  it('enables Disconnect once connected', async () => {
    renderApp('Connected');

    await waitFor(() => expect(screen.getByRole('button', { name: 'Disconnect' })).toBeEnabled());
  });

  it('disables Subscribe and Publish while there is no connection', async () => {
    renderApp('Disconnected');

    expect(await openPanelButton('Subscribe')).toBeDisabled();
    expect(await openPanelButton('Publish')).toBeDisabled();
  });

  it('enables Subscribe and Publish once connected', async () => {
    renderApp('Connected');

    await waitFor(async () => expect(await openPanelButton('Subscribe')).toBeEnabled());
    await waitFor(async () => expect(await openPanelButton('Publish')).toBeEnabled());
  });

  // The bar carries the state alone; the address it is connected to lives in the broker panel.
  it('shows the state, not the address, in the readout while connected', async () => {
    renderApp('Connected');

    expect(await screen.findByText('CONNECTED')).toBeInTheDocument();
    expect(screen.queryByText(/CONNECTED ·/)).not.toBeInTheDocument();
  });

  it('shows the bare state when there is no connection', async () => {
    renderApp('Disconnected');

    expect(await screen.findByText('DISCONNECTED')).toBeInTheDocument();
  });

  it('reports a hub reconnect in the readout', async () => {
    const hub = renderApp('Connected');
    await screen.findByText('CONNECTED');

    hub.emit('reconnecting');

    expect(await screen.findByText('RECONNECTING')).toBeInTheDocument();
  });

  it('goes back to the broker state once the hub returns', async () => {
    const hub = renderApp('Connected');
    hub.emit('reconnecting');
    await screen.findByText('RECONNECTING');

    hub.emit('reconnected');

    expect(await screen.findByText('CONNECTED')).toBeInTheDocument();
  });

  // The saved settings record the last connect that WORKED, which is a different question
  // from what is up right now — and they are written on a best-effort basis at that.
  // The broker panel is where that address is spelled out, so it is read from there.
  it('reads the address off the live link, not the last saved settings', async () => {
    renderApp('Connected', { ...LINK, host: 'live.example', port: 1884 });

    const details = await screen.findByLabelText('Connection details');
    expect(within(details).getByText('live.example:1884')).toBeInTheDocument();
  });
});
