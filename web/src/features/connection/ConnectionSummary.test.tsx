import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { server } from '../../test/server';
import { ConnectionSummary } from './ConnectionSummary';

const LINK = {
  host: 'broker.example',
  port: 8883,
  clientId: 'console',
  username: 'alice',
  useTls: true,
  connectedAt: '2026-08-08T12:00:00Z',
  sessionPresent: false,
  assignedClientId: null,
  serverKeepAlive: null,
};

function renderSummary(connection: unknown = LINK, subscriptions: string[] = []) {
  server.use(
    http.get('/api/connection', () =>
      HttpResponse.json({ state: connection ? 'Connected' : 'Disconnected', connection }),
    ),
    http.get('/api/subscriptions', () => HttpResponse.json(subscriptions)),
  );

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(<ConnectionSummary />, { wrapper });
}

// Each label owns one value, so read the value out of the row its label sits in.
async function readValue(label: string) {
  const list = await screen.findByLabelText('Connection details');
  const term = within(list).getByText(label);
  return term.parentElement!.querySelector('dd')!;
}

describe('ConnectionSummary', () => {
  // findBy, not queryBy: the connection query resolves a tick after render, so a synchronous
  // queryBy here would pass before the component had any link to reject. This waits the block
  // out — a second of test time to prove an absence that means something.
  it('shows nothing while there is no link', async () => {
    renderSummary(null);

    await expect(screen.findByLabelText('Connection details')).rejects.toThrow();
  });

  it('names the broker the link is to', async () => {
    renderSummary();

    expect(await readValue('Broker')).toHaveTextContent('broker.example:8883');
  });

  it('shows the identity the link was made with', async () => {
    renderSummary();

    expect(await readValue('Client ID')).toHaveTextContent('console');
    expect(await readValue('Username')).toHaveTextContent('alice');
    expect(await readValue('TLS')).toHaveTextContent('on');
  });

  // Leaving the username blank is an answer, not a gap in what the broker told us.
  it('says so plainly when no username was used', async () => {
    renderSummary({ ...LINK, username: null, useTls: false });

    expect(await readValue('Username')).toHaveTextContent('none');
    expect(await readValue('TLS')).toHaveTextContent('off');
  });

  it('says whether the broker resumed a session', async () => {
    renderSummary({ ...LINK, sessionPresent: true });

    expect(await readValue('Session')).toHaveTextContent('resumed');
  });

  it('says a session is fresh when the broker started one', async () => {
    renderSummary();

    expect(await readValue('Session')).toHaveTextContent('fresh');
  });

  // A dash, not a missing row: the field was asked about and the broker said nothing.
  it('dashes the fields the broker did not fill in', async () => {
    renderSummary();

    expect(await readValue('Assigned ID')).toHaveTextContent('—');
    expect(await readValue('Keep-alive')).toHaveTextContent('—');
  });

  it('shows the id and keep-alive the broker imposed', async () => {
    renderSummary({ ...LINK, assignedClientId: 'auto-4417', serverKeepAlive: 30 });

    expect(await readValue('Assigned ID')).toHaveTextContent('auto-4417');
    expect(await readValue('Keep-alive')).toHaveTextContent('30 sec');
  });

  // A zero here means MQTT keep-alive was turned off, not a keep-alive of no seconds, so it
  // dashes the same as the broker saying nothing — do not "fix" this to render "0 sec".
  it('dashes a keep-alive of zero rather than reading it as no seconds', async () => {
    renderSummary({ ...LINK, serverKeepAlive: 0 });

    expect(await readValue('Keep-alive')).toHaveTextContent('—');
  });

  // The count lands a tick after the block does: the subscriptions query only starts once
  // there is a link to count filters for.
  it('counts the topic filters in play', async () => {
    renderSummary(LINK, ['sensors/#', 'devices/+/state']);

    await waitFor(async () => expect(await readValue('Subscriptions')).toHaveTextContent('2'));
  });
});
