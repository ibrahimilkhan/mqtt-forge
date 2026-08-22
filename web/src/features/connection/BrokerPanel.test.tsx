import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useLogStore } from '../../stores/logStore';
import { useTopicTreeStore } from '../../stores/topicTreeStore';
import { server } from '../../test/server';
import { BrokerPanel } from './BrokerPanel';
import { BROKER_PRESETS } from './presets';

const newQueryClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

// Takes a client so a test can reopen the panel against the state the first one left behind.
function renderPanel(queryClient = newQueryClient()) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const onClose = vi.fn();
  return { ...render(<BrokerPanel onClose={onClose} />, { wrapper }), onClose };
}

beforeEach(() => {
  useLogStore.getState().clear();
  useTopicTreeStore.getState().reset();
});

// Mirrors the API's abort flow: the connect stays open and the state reads Connecting until
// something calls the attempt off, and only then does the POST answer — with a 409.
function trackAttempt() {
  let state = 'Disconnected';
  let calledOff!: () => void;
  const cancellation = new Promise<void>((resolve) => {
    calledOff = resolve;
  });

  const attempt = {
    cancelled: false,
    handlers: [
      http.get('/api/connection', () => HttpResponse.json({ state })),
      http.post('/api/connection', async () => {
        state = 'Connecting';
        await cancellation;
        return HttpResponse.json(
          { title: 'Connect aborted', detail: 'The attempt was cancelled.', reason: 'aborted' },
          { status: 409 },
        );
      }),
      http.delete('/api/connection/attempt', () => {
        attempt.cancelled = true;
        state = 'Disconnected';
        calledOff();
        return new HttpResponse(null, { status: 204 });
      }),
    ],
  };

  return attempt;
}

describe('BrokerPanel', () => {
  it('fills the form from the saved settings', async () => {
    server.use(
      http.get('/api/connection/settings', () =>
        HttpResponse.json({
          host: 'broker.example',
          port: 8883,
          clientId: 'saved-client',
          username: 'alice',
          hasPassword: true,
          useTls: true,
        }),
      ),
    );

    renderPanel();

    // Defaults render first; filled once the query resolves.
    await waitFor(() => expect(screen.getByLabelText('Host')).toHaveValue('broker.example'));
    expect(screen.getByLabelText('Port')).toHaveValue(8883);
    expect(screen.getByLabelText('Client ID')).toHaveValue('saved-client');
    expect(screen.getByLabelText('Username')).toHaveValue('alice');
    expect(screen.getByLabelText('Use TLS')).toBeChecked();
  });

  it('says a password is stored but never returned', async () => {
    server.use(
      http.get('/api/connection/settings', () =>
        HttpResponse.json({
          host: 'h',
          port: 1883,
          clientId: 'c',
          username: null,
          hasPassword: true,
          useTls: false,
        }),
      ),
    );

    renderPanel();

    expect(
      await screen.findByText('A password is saved but never sent back. Enter it again to connect.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toHaveValue('');
  });

  // The panel is here to get a link up. Once one is up it is a form nobody is filling in, and
  // the column it holds is worth more to the traffic that has just started arriving.
  it('closes itself the moment the link comes up', async () => {
    let state = 'Disconnected';
    server.use(
      http.get('/api/connection', () => HttpResponse.json({ state })),
      http.post('/api/connection', () => {
        state = 'Connected';
        return HttpResponse.json({ state: 'Connected' });
      }),
      http.post('/api/subscriptions', () => new HttpResponse(null, { status: 202 })),
    );

    const { onClose } = renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  // Reopened over a link that is already up — to read the summary, or to disconnect — nothing
  // has just happened, and shutting it in the reader's face would be a bug, not a courtesy.
  it('stays open when it is opened over a link that is already up', async () => {
    server.use(http.get('/api/connection', () => HttpResponse.json({ state: 'Connected' })));

    const { onClose } = renderPanel();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Disconnect' })).toBeEnabled());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('subscribes to everything after connecting when the box is ticked', async () => {
    let subscribed: unknown;
    server.use(
      http.post('/api/connection', () => HttpResponse.json({ state: 'Connected' })),
      http.post('/api/subscriptions', async ({ request }) => {
        subscribed = await request.json();
        return new HttpResponse(null, { status: 202 });
      }),
    );

    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(subscribed).toEqual({ topicFilter: '#', qos: 0 }));
  });

  it('clears the tree on a fresh connect, because retained messages refill it', async () => {
    server.use(
      http.post('/api/connection', () => HttpResponse.json({ state: 'Connected' })),
      http.post('/api/subscriptions', () => new HttpResponse(null, { status: 202 })),
    );
    useTopicTreeStore
      .getState()
      .apply([
        {
          topic: 'stale/topic',
          payload: '1',
          mode: 'text',
          size: 1,
          qos: 0,
          retain: false,
          receivedAt: '2026-07-26T10:00:00Z',
        },
      ]);

    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(useTopicTreeStore.getState().root.children.size).toBe(0));
  });

  it('leaves the tree and log alone when the API reports the settings are unchanged', async () => {
    server.use(
      http.post('/api/connection', () =>
        HttpResponse.json({ state: 'Connected', alreadyConnected: true }),
      ),
    );
    useTopicTreeStore
      .getState()
      .apply([
        {
          topic: 'stale/topic',
          payload: '1',
          mode: 'text',
          size: 1,
          qos: 0,
          retain: false,
          receivedAt: '2026-07-26T10:00:00Z',
        },
      ]);

    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));

    await waitFor(() =>
      expect(useLogStore.getState().commands[0]).toMatchObject({ kind: 'ok', verb: 'Already connected' }),
    );
    expect(useTopicTreeStore.getState().root.children.size).toBe(1);
  });

  it('logs a fault with the reason when the broker refuses', async () => {
    server.use(
      http.post('/api/connection', () =>
        HttpResponse.json({ title: 'Broker unreachable', detail: 'Connection refused' }, { status: 502 }),
      ),
    );

    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));

    await waitFor(() =>
      expect(useLogStore.getState().commands[0]).toMatchObject({
        kind: 'fault',
        verb: 'Connect failed',
        body: 'Connection refused',
      }),
    );
  });

  it('shows why the connect failed, in words, under the buttons', async () => {
    server.use(
      http.post('/api/connection', () =>
        HttpResponse.json(
          { title: 'Could not connect to broker', detail: 'Connection refused', reason: 'refused' },
          { status: 502 },
        ),
      ),
    );

    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Nothing is listening at localhost:1883.');
  });

  // No connect attempt in play — the panel was reopened after the link died on its own.
  it('shows why a live connection dropped', async () => {
    server.use(
      http.get('/api/connection', () =>
        HttpResponse.json({
          state: 'Faulted',
          failure: {
            reason: 'sessionTakenOver',
            host: 'broker.example',
            port: 1883,
            clientId: 'live-client',
            useTls: false,
          },
        }),
      ),
    );

    renderPanel();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Another client connected with the client ID 'live-client'.",
    );
  });

  // The saved settings record the last connect that WORKED, so they are the wrong thing to
  // name when an attempt to somewhere else is what failed.
  it('names the broker the failure is about, not the one last saved', async () => {
    server.use(
      http.get('/api/connection', () =>
        HttpResponse.json({
          state: 'Faulted',
          failure: {
            reason: 'refused',
            host: 'localhost',
            port: 1999,
            clientId: 'probe',
            useTls: false,
          },
        }),
      ),
      http.get('/api/connection/settings', () =>
        HttpResponse.json({
          host: 'broker.example',
          port: 8883,
          clientId: 'saved-client',
          username: null,
          hasPassword: false,
          useTls: false,
        }),
      ),
    );

    renderPanel();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Nothing is listening at localhost:1999.',
    );
  });

  it('stays quiet when the connection state carries no failure', async () => {
    server.use(http.get('/api/connection', () => HttpResponse.json({ state: 'Faulted' })));

    renderPanel();

    await screen.findByRole('button', { name: 'Connect' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a validation error beside the field it belongs to', async () => {
    server.use(
      http.post('/api/connection', () =>
        HttpResponse.json(
          { title: 'One or more validation errors occurred.', errors: { Host: ['Host is required'] } },
          { status: 400 },
        ),
      ),
    );

    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));

    expect(await screen.findByText('Host is required')).toBeInTheDocument();
    // The field already says it; a second copy under the buttons would just be noise.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('ignores extra clicks fired while a connect is already in flight', async () => {
    let calls = 0;
    server.use(
      http.post('/api/connection', async () => {
        calls += 1;
        await delay(20);
        return HttpResponse.json({ state: 'Connected' });
      }),
      http.post('/api/subscriptions', () => new HttpResponse(null, { status: 202 })),
    );

    renderPanel();
    const button = await screen.findByRole('button', { name: 'Connect' });

    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(button).not.toBeDisabled());
    expect(calls).toBe(1);
  });

  // An attempt already running when the panel opens is the state a user lands in after
  // switching panels; the server knows about it even though this mount never started it.
  it('offers Abort for an attempt that was already running when it opened', async () => {
    server.use(http.get('/api/connection', () => HttpResponse.json({ state: 'Connecting' })));

    renderPanel();

    expect(await screen.findByRole('button', { name: 'Abort' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument();
  });

  it('calls the attempt off when Abort is pressed', async () => {
    let cancelled = false;
    server.use(
      http.get('/api/connection', () => HttpResponse.json({ state: 'Connecting' })),
      http.delete('/api/connection/attempt', () => {
        cancelled = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'Abort' }));

    await waitFor(() => expect(cancelled).toBe(true));
  });

  // The complaint this whole thing is about: leave the panel mid-connect, come back, and the
  // attempt you started is nowhere to be seen.
  it('finds the running attempt again after the panel is closed and reopened', async () => {
    const attempt = trackAttempt();
    server.use(...attempt.handlers);
    const queryClient = newQueryClient();

    const first = renderPanel(queryClient);
    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));
    await screen.findByRole('button', { name: 'Abort' });
    first.unmount();
    renderPanel(queryClient);

    // Not just showing the button — the reopened panel can actually stop the attempt.
    await userEvent.click(await screen.findByRole('button', { name: 'Abort' }));
    await waitFor(() => expect(attempt.cancelled).toBe(true));
  });

  it('logs an aborted attempt as aborted, and leaves no fault on screen', async () => {
    const attempt = trackAttempt();
    server.use(...attempt.handlers);

    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Abort' }));

    await waitFor(() =>
      expect(useLogStore.getState().commands[0]).toMatchObject({ verb: 'Connect aborted' }),
    );
    expect(useLogStore.getState().commands[0].kind).not.toBe('fault');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('ignores extra clicks fired while a disconnect is already in flight', async () => {
    let calls = 0;
    server.use(
      http.get('/api/connection', () => HttpResponse.json({ state: 'Connected' })),
      http.delete('/api/connection', async () => {
        calls += 1;
        await delay(20);
        return new HttpResponse(null, { status: 204 });
      }),
    );

    renderPanel();
    const button = await screen.findByRole('button', { name: 'Disconnect' });
    await waitFor(() => expect(button).not.toBeDisabled());

    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(calls).toBe(1));
  });

  it('shows the live link under the form once connected', async () => {
    server.use(
      http.get('/api/connection', () =>
        HttpResponse.json({
          state: 'Connected',
          connection: {
            host: 'broker.example',
            port: 8883,
            clientId: 'console',
            username: null,
            useTls: true,
            connectedAt: '2026-08-08T12:00:00Z',
            sessionPresent: false,
            assignedClientId: null,
            serverKeepAlive: null,
          },
        }),
      ),
    );

    renderPanel();

    const details = await screen.findByLabelText('Connection details');
    expect(within(details).getByText('broker.example:8883')).toBeInTheDocument();
  });

  it('refuses a second connect while one is already live', async () => {
    server.use(http.get('/api/connection', () => HttpResponse.json({ state: 'Connected' })));

    renderPanel();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Disconnect' })).not.toBeDisabled();
  });

  it('leaves the form alone while nothing is connected', async () => {
    renderPanel();

    await screen.findByRole('button', { name: 'Connect' });
    expect(screen.queryByLabelText('Connection details')).not.toBeInTheDocument();
  });
});

// Pointing this console somewhere real used to mean knowing a hostname, a port, whether it
// wanted TLS, and — the part that actually caught people — a filter it would answer. The chips
// carry all four. They fill the form and stop there: connecting is still the reader's move.
describe('the broker presets', () => {
  const hsl = BROKER_PRESETS.find((p) => p.name === 'Helsinki transit')!;

  const pick = (name: string) => userEvent.click(screen.getByRole('button', { name }));

  it('fills the address from the chip', async () => {
    renderPanel();
    await pick(hsl.name);

    expect(screen.getByLabelText('Host')).toHaveValue(hsl.host);
    expect(screen.getByLabelText('Port')).toHaveValue(hsl.port);
  });

  it('brings the TLS setting with the port, rather than leaving the two disagreeing', async () => {
    renderPanel();
    await pick(hsl.name);

    expect(screen.getByLabelText('Use TLS')).toBeChecked();
  });

  // The half a bare address does not give you, and the reason the console used to connect to
  // this broker and immediately fall over: it refuses '#' by closing the session.
  it('brings a filter the broker will actually answer', async () => {
    renderPanel();
    await pick(hsl.name);

    expect(screen.getByLabelText('On-connect filter')).toHaveValue(hsl.onConnectFilter);
    expect(screen.getByLabelText('On-connect filter')).not.toHaveValue('#');
  });

  it('subscribes to the preset filter on connect, not to everything', async () => {
    let subscribed: unknown;
    server.use(
      http.post('/api/connection', () => HttpResponse.json({ state: 'Connected' })),
      http.post('/api/subscriptions', async ({ request }) => {
        subscribed = await request.json();
        return new HttpResponse(null, { status: 202 });
      }),
    );

    renderPanel();
    await pick(hsl.name);
    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));

    await waitFor(() =>
      expect(subscribed).toEqual({ topicFilter: hsl.onConnectFilter, qos: 0 }),
    );
  });

  it('marks the chip the form is sitting on', async () => {
    renderPanel();
    await pick(hsl.name);

    expect(screen.getByRole('button', { name: hsl.name })).toHaveAttribute('aria-pressed', 'true');
  });

  // Derived from the fields rather than remembered, so a form that is no longer the preset
  // cannot go on claiming to be it.
  it('stops marking the chip once the host is typed over', async () => {
    renderPanel();
    await pick(hsl.name);
    await userEvent.clear(screen.getByLabelText('Host'));
    await userEvent.type(screen.getByLabelText('Host'), 'somewhere.else');

    expect(screen.getByRole('button', { name: hsl.name })).toHaveAttribute('aria-pressed', 'false');
  });

  // These are all public brokers, and a password typed for a private one has no business
  // riding along to them.
  it('does not carry a typed password over to a preset', async () => {
    renderPanel();
    await userEvent.type(screen.getByLabelText('Password'), 'private-secret');
    await pick(hsl.name);

    expect(screen.getByLabelText('Password')).toHaveValue('');
  });

  // Found running the real thing: reopen the panel over a saved Helsinki connection, press
  // Connect, and it sent a bare '#' — which that broker refuses by closing the session. The
  // address came back from the saved settings and the filter did not, so the one part of the
  // preset that makes it work was the part that was lost.
  it('brings the filter back with a broker it has connected to before', async () => {
    server.use(
      http.get('/api/connection/settings', () =>
        HttpResponse.json({
          host: hsl.host,
          port: hsl.port,
          clientId: 'mqttforge-console',
          username: null,
          hasPassword: false,
          useTls: hsl.useTls,
        }),
      ),
    );

    renderPanel();

    await waitFor(() =>
      expect(screen.getByLabelText('On-connect filter')).toHaveValue(hsl.onConnectFilter),
    );
  });

  // A broker nobody has a preset for gets the same '#' it always did: there is nothing better
  // to guess, and guessing a filter for an address we know nothing about would be worse.
  it('leaves the filter alone for a saved broker it has no preset for', async () => {
    server.use(
      http.get('/api/connection/settings', () =>
        HttpResponse.json({
          host: 'broker.example',
          port: 1883,
          clientId: 'mqttforge-console',
          username: null,
          hasPassword: false,
          useTls: false,
        }),
      ),
    );

    renderPanel();

    await waitFor(() => expect(screen.getByLabelText('Host')).toHaveValue('broker.example'));
    expect(screen.getByLabelText('On-connect filter')).toHaveValue('#');
  });

  it('explains what the broker is once one is picked', async () => {
    renderPanel();
    await pick(hsl.name);

    expect(screen.getByText(hsl.note)).toBeInTheDocument();
  });
});
