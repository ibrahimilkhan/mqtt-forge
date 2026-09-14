import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { createFakeHub } from '../realtime/fakeHub';
import { useHubStatusStore } from '../stores/hubStatusStore';
import { server } from '../test/server';
import { useConnectionState } from './useConnectionState';

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
  // Not "disabled": absent. Disconnect stands with the link it would end, and with nothing
  // connected there is no link and no block for it to stand in — a greyed button for something
  // that does not exist is a control the reader has to rule out on every visit.
  it('offers no Disconnect while there is no connection', async () => {
    renderApp('Disconnected');

    expect(await screen.findByRole('button', { name: 'Connect' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument();
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

  // The state is worn by the Broker row and by nothing else. There used to be a lamp and a word
  // at the top of the rail saying the same thing in a different vocabulary.
  const brokerRow = () => screen.getByRole('button', { name: /^Broker/ });

  it('wears the state on the Broker row', async () => {
    renderApp('Connected');

    await waitFor(() => expect(brokerRow()).toHaveAttribute('data-link', 'Connected'));
  });

  it('reports a hub reconnect on the same row', async () => {
    const hub = renderApp('Connected');
    await waitFor(() => expect(brokerRow()).toHaveAttribute('data-link', 'Connected'));

    hub.emit('reconnecting');

    await waitFor(() => expect(brokerRow()).toHaveAttribute('data-link', 'Reconnecting'));
  });

  it('goes back to the broker state once the hub returns', async () => {
    const hub = renderApp('Connected');
    hub.emit('reconnecting');
    await waitFor(() => expect(brokerRow()).toHaveAttribute('data-link', 'Reconnecting'));

    hub.emit('reconnected');

    await waitFor(() => expect(brokerRow()).toHaveAttribute('data-link', 'Connected'));
  });

  // The saved settings record the last connect that WORKED, which is a different question
  // from what is up right now — and they are written on a best-effort basis at that.
  // The broker panel is where that address is spelled out, so it is read from there.
  it('reads the address off the live link, not the last saved settings', async () => {
    renderApp('Connected', { ...LINK, host: 'live.example', port: 1884 });

    await screen.findByLabelText('Connection details');
    // On the status head above the list, which is the one place it is said now.
    expect(screen.getByText('live.example:1884')).toBeInTheDocument();
  });
});

describe('the state as the console holds it', () => {
  // The fetch is one of the two ways the console hears what the link is, and a link coming back is
  // dated by when it heard — so the answer is dated when it lands, as the hub bridge dates a push.
  it('dates the answer by when it landed, not by when it was asked for', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(4_000);
      server.use(
        http.get('/api/connection', () => {
          // The answer is on its way back: anything stamped from here on was stamped as it landed.
          vi.setSystemTime(5_000);
          return HttpResponse.json({ state: 'Connected', connection: LINK });
        }),
      );

      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const { result } = renderHook(() => useConnectionState(), {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        ),
      });

      await waitFor(() => expect(result.current.answered).toBe(true));
      expect(result.current.seenAt).toBe(5_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
