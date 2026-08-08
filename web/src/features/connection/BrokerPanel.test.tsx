import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useLogStore } from '../../stores/logStore';
import { useTopicTreeStore } from '../../stores/topicTreeStore';
import { server } from '../../test/server';
import { BrokerPanel } from './BrokerPanel';

const newQueryClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

// Takes a client so a test can reopen the panel against the state the first one left behind.
function renderPanel(queryClient = newQueryClient()) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(<BrokerPanel onClose={vi.fn()} />, { wrapper });
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
        { topic: 'stale/topic', payload: '1', qos: 0, retain: false, receivedAt: '2026-07-26T10:00:00Z' },
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
      .apply([{ topic: 'stale/topic', payload: '1', qos: 0, retain: false, receivedAt: '2026-07-26T10:00:00Z' }]);

    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));

    await waitFor(() =>
      expect(useLogStore.getState().entries[0]).toMatchObject({ kind: 'ok', verb: 'Already connected' }),
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
      expect(useLogStore.getState().entries[0]).toMatchObject({
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
      expect(useLogStore.getState().entries[0]).toMatchObject({ verb: 'Connect aborted' }),
    );
    expect(useLogStore.getState().entries[0].kind).not.toBe('fault');
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
});
