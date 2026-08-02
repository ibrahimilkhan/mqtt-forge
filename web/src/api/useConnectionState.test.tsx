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

function renderApp(state: string) {
  const hub = createFakeHub();
  server.use(
    http.get('/api/connection', () => HttpResponse.json({ state })),
    http.get('/api/connection/settings', () =>
      HttpResponse.json({
        host: 'broker.example',
        port: 8883,
        clientId: 'c',
        username: null,
        hasPassword: false,
        useTls: true,
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
async function openPanelButton(name: 'Subscribe' | 'Publish') {
  const menu = screen.getByRole('navigation', { name: 'Panels' });
  await userEvent.click(within(menu).getByRole('button', { name }));

  const panel = screen.getByRole('region', { name: `${name} panel` });
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

  it('shows the broker address in the readout while connected', async () => {
    renderApp('Connected');

    expect(await screen.findByText('CONNECTED · broker.example:8883')).toBeInTheDocument();
  });

  it('leaves the address off when there is no connection', async () => {
    renderApp('Disconnected');

    expect(await screen.findByText('DISCONNECTED')).toBeInTheDocument();
  });

  it('reports a hub reconnect in the readout', async () => {
    const hub = renderApp('Connected');
    await screen.findByText('CONNECTED · broker.example:8883');

    hub.emit('reconnecting');

    expect(await screen.findByText('RECONNECTING')).toBeInTheDocument();
  });

  it('goes back to the broker state once the hub returns', async () => {
    const hub = renderApp('Connected');
    hub.emit('reconnecting');
    await screen.findByText('RECONNECTING');

    hub.emit('reconnected');

    expect(await screen.findByText('CONNECTED · broker.example:8883')).toBeInTheDocument();
  });
});
