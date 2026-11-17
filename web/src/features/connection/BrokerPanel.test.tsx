import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrokerEventsStore } from '../../stores/brokerEventsStore';
import { useHubStatusStore } from '../../stores/hubStatusStore';
import { useLogStore } from '../../stores/logStore';
import { useTopicTreeStore } from '../../stores/topicTreeStore';
import { queryKeys } from '../../api/queryKeys';
import { server } from '../../test/server';
import { BrokerPanel, SAY_AFTER, SETTLE } from './BrokerPanel';

// A saved connection as the API sends one. Written here rather than inline in six places so a
// test says only what it is about — the host, or the filter, or the password — and the rest of
// the shape stays in one place to be corrected in one place.
const savedConnection = (over: Record<string, unknown> = {}) => ({
  host: 'broker.example',
  port: 1883,
  clientId: 'mqttforge-console',
  username: null,
  hasPassword: false,
  useTls: false,
  transport: 'tcp',
  protocolVersion: 'auto',
  webSocketPath: null,
  cleanSession: true,
  sessionExpiryInterval: null,
  tls: null,
  ...over,
});

const newQueryClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

// Takes a client so a test can reopen the panel against the state the first one left behind.
function renderPanel(queryClient = newQueryClient()) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const onClose = vi.fn();
  return { ...render(<BrokerPanel onClose={onClose} />, { wrapper }), onClose };
}

// The way in is one box of four at the head of the address. These choose one and read which is
// chosen by the scheme each is written with — the form's own word for the same thing.
type Way = 'mqtt' | 'mqtts' | 'ws' | 'wss';
const protocol = () => screen.getByLabelText<HTMLSelectElement>('Protocol');
const pickWay = (scheme: Way) => userEvent.selectOptions(protocol(), scheme);
const chosenWay = () => protocol().value;

// What the Topics on connect sheet says the list holds: the ticks that are on, then the chips,
// in the order they are drawn. Read off the DOM rather than by role, because the sheet is shut
// until somebody opens it and a shut sheet is not in the accessibility tree.
const listed = () => {
  const list = screen.getByLabelText('Subscribed on connect');

  return [
    ...[...list.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked')].map(
      (box) => box.closest('label')!.querySelector('span')!.textContent,
    ),
    ...[...list.querySelectorAll('button')].map((drop) =>
      drop.getAttribute('aria-label')!.replace(/^Remove /, ''),
    ),
  ];
};

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
        HttpResponse.json(
          savedConnection({
            port: 8883,
            clientId: 'saved-client',
            username: 'alice',
            hasPassword: true,
            useTls: true,
            protocolVersion: 'v311',
          }),
        ),
      ),
    );

    renderPanel();

    // Defaults render first; filled once the query resolves. The scheme comes back written into
    // the address, since that is where it was saved from: this connection was over TLS.
    await waitFor(() =>
      expect(screen.getByLabelText('Address')).toHaveValue('broker.example'),
    );
    expect(screen.getByLabelText('Port')).toHaveValue(8883);
    expect(screen.getByLabelText('Client ID')).toHaveValue('saved-client');
    expect(screen.getByLabelText('Username')).toHaveValue('alice');
    // The way in comes back as the one it was saved as: this connection was over TLS.
    expect(chosenWay()).toBe('mqtts');
  });

  it('leaves the password box empty, whatever is stored', async () => {
    server.use(
      http.get('/api/connection/settings', () =>
        HttpResponse.json(savedConnection({ host: 'h', clientId: 'c', hasPassword: true })),
      ),
    );

    renderPanel();

    await screen.findByLabelText('Address');
    expect(screen.getByLabelText('Password')).toHaveValue('');
  });

  // The panel is here to get a link up. Once one is up it is a form nobody is filling in, and
  // the column it holds is worth more to the traffic that has just started arriving.
  it('closes itself once the link has held', async () => {
    let state = 'Disconnected';
    server.use(
      http.get('/api/connection', () => HttpResponse.json({ state })),
      http.post('/api/connection', () => {
        state = 'Connected';
        return HttpResponse.json({ state: 'Connected' });
      }),
      http.post('/api/subscriptions', () => new HttpResponse(null, { status: 202 })),
    );

    const client = newQueryClient();
    const { onClose } = renderPanel(client);
    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));

    // Not on the announcement of a link — see the two tests under this one for why. The cache is
    // what says the link is up: nothing on screen does, which is the point.
    await waitFor(() =>
      expect(client.getQueryData(queryKeys.connection)).toMatchObject({ state: 'Connected' }),
    );
    expect(onClose).not.toHaveBeenCalled();

    await waitFor(() => expect(onClose).toHaveBeenCalled(), { timeout: SETTLE + 1000 });
  });

  // The link coming up moves nothing on the panel until it has held. Connecting to a broker that
  // hangs up on the subscribe used to put the whole live block on screen and take it off again
  // inside 110ms — 752px to 1077px to 874px, measured — which is a 325px block opening and
  // shutting under the reader's eyes for a connection that never happened.
  it('moves nothing on the panel while the link is settling', async () => {
    let state = 'Disconnected';
    server.use(
      http.get('/api/connection', () => HttpResponse.json({ state })),
      http.post('/api/connection', () => {
        state = 'Connected';
        return HttpResponse.json({ state: 'Connected' });
      }),
      http.post('/api/subscriptions', () => new HttpResponse(null, { status: 202 })),
    );

    const client = newQueryClient();
    renderPanel(client);
    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));

    await waitFor(() =>
      expect(client.getQueryData(queryKeys.connection)).toMatchObject({ state: 'Connected' }),
    );

    // The link is up and the panel does not say so: no summary, no Disconnect.
    expect(screen.queryByLabelText('Connection details')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument();
  });

  // Why the close waits at all. Every topic is what this console asks for on connect, and a good
  // many brokers answer by taking the connection and then hanging up — against mqtt.hsl.fi the
  // whole of it lands inside 150ms. Closing on the announcement left the reader looking at a
  // console with no panel and no sentence, having to reopen the panel to find out what had become
  // of the connect they had just pressed.
  it('stays open when the link comes up and then dies', async () => {
    let state = 'Disconnected';
    server.use(
      http.get('/api/connection', () => HttpResponse.json({ state })),
      http.post('/api/connection', () => {
        state = 'Connected';
        return HttpResponse.json({ state: 'Connected' });
      }),
      http.post('/api/subscriptions', () => new HttpResponse(null, { status: 202 })),
    );

    const client = newQueryClient();
    const { onClose } = renderPanel(client);
    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));

    // The link is up and the close is armed. Read off the cache: through the settle the panel
    // shows nothing about it.
    await waitFor(() =>
      expect(client.getQueryData(queryKeys.connection)).toMatchObject({ state: 'Connected' }),
    );

    // And the broker hangs up, which is how the hub delivers it.
    state = 'Faulted';
    act(() =>
      client.setQueryData(queryKeys.connection, {
        state: 'Faulted',
        failure: {
          reason: 'notPermitted',
          host: 'broker.example',
          port: 1883,
          clientId: 'mqttforge-console',
          useTls: false,
          transport: 'tcp',
          protocolVersion: 'auto',
        },
      }),
    );

    expect(await screen.findByRole('alert')).toBeInTheDocument();

    await new Promise((resolve) => setTimeout(resolve, SETTLE + 300));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeInTheDocument();
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

    // At the ceiling, so an arrival's QoS stamp is the publisher's answer rather than this
    // console's own cap. See EVERYTHING_QOS.
    await waitFor(() => expect(subscribed).toEqual({ topicFilter: '#', qos: 2 }));
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
            transport: 'tcp',
            protocolVersion: 'auto',
          },
        }),
      ),
      http.get('/api/connection/settings', () =>
        HttpResponse.json(savedConnection({ port: 8883, clientId: 'saved-client' })),
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

  it('names the broker it is connected to', async () => {
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

    // Above the list rather than in it: the status head carries the address, and the list would
    // otherwise say the same broker twice two lines apart.
    await screen.findByLabelText('Connection details');
    expect(screen.getByText('broker.example:8883')).toBeInTheDocument();
    // And the state itself, in words, which nine rows of true facts never said.
    expect(screen.getByText('Connected')).toBeInTheDocument();
    // The row that used to wear that word says what its value is instead.
    expect(screen.getByText('Since')).toBeInTheDocument();
  });

  it('offers no second connect while one is already live', async () => {
    server.use(http.get('/api/connection', () => HttpResponse.json({ state: 'Connected' })));

    renderPanel();

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Disconnect' })).not.toBeDisabled(),
    );
    expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument();
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



// ---- what the panel puts in front of you, and what it keeps behind a line ----
//
// Measured at the panel's own width, the form that showed everything at once ran to 1477px in a
// 900px window, and the two controls every connection goes through — the address and the button
// — were 98px of it. These say which parts are which, because a control inside a shut <details>
// is still in the DOM and every other test here would pass either way.

// The sheets under the address are lines that open and shut, and say which in aria-expanded.
const fold = (name: string) => ({
  get open() {
    return (
      screen.getByRole('button', { name: new RegExp(`^${name}`) }).getAttribute('aria-expanded') ===
      'true'
    );
  },
});

describe('what the panel shows first', () => {
  const connected = () =>
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

  it('leads with the address, which is the only thing the reader has', async () => {
    renderPanel();

    await screen.findByRole('button', { name: 'Connect' });
    expect(screen.getByLabelText('Address')).toBeInTheDocument();
  });

  // Six fields the great majority of connections never need. The client ID is not among them
  // any more: brokers refuse connections over it and log by it.
  // The form is an address and three folds. A bench broker needs nothing but the address; a name,
  // a subscription list and a certificate are each one line away.
  it('keeps the client, the subscription and the certificates behind lines', async () => {
    renderPanel();

    await screen.findByRole('button', { name: 'Connect' });
    expect(fold('Sign-in').open).toBe(false);
    expect(fold('Topics on connect').open).toBe(false);
    expect(fold('Security').open).toBe(false);
    expect(screen.getByLabelText('Address')).toBeVisible();
    expect(screen.queryByText('Client and session')).not.toBeInTheDocument();
  });

  // Lines down the column, each opening where it stands. Opening one leaves the others as they
  // were — a username and a certificate are both part of one connection — and pressing an open
  // one shuts it.
  it('opens each sheet by itself, and shuts the open one when it is pressed again', async () => {
    renderPanel();

    await screen.findByRole('button', { name: 'Connect' });
    await userEvent.click(screen.getByRole('button', { name: 'Sign-in' }));
    expect(fold('Sign-in').open).toBe(true);
    expect(screen.getByLabelText('Username')).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: 'Security' }));
    expect(fold('Sign-in').open).toBe(true);
    expect(fold('Security').open).toBe(true);

    await userEvent.click(screen.getByRole('button', { name: 'Security' }));
    expect(fold('Security').open).toBe(false);
    expect(fold('Sign-in').open).toBe(true);
  });

  // The line is its name alone, to the eye and to anything asking for it: what the sheet holds
  // is the line's description and is not drawn beside the name.
  it('draws each line as its name and nothing more', async () => {
    renderPanel();

    const signIn = await screen.findByRole('button', { name: 'Sign-in' });
    expect(signIn).toHaveAccessibleName('Sign-in');
    expect(signIn).toHaveAccessibleDescription(/^anonymous · /);
    expect(within(signIn).getByText(/^anonymous · /)).not.toBeVisible();
    expect(within(signIn).queryByText(/^(Edit|View|Close)$/)).not.toBeInTheDocument();
  });

  // What the console does if the link goes is one tick under the address, with its own words
  // beside it — not a fourth line among the settings with a name over it.
  it('keeps the reconnect tick under the address, with no heading of its own', async () => {
    renderPanel();

    const tick = await screen.findByRole('checkbox', { name: /Reconnect automatically/ });
    expect(tick.closest('section')).toBe(screen.getByLabelText('Address').closest('section'));
    expect(screen.queryByText('If the link drops')).not.toBeInTheDocument();
  });

  // The button the panel exists for stands on the address's own line.
  it('puts Connect beside the address it uses', async () => {
    renderPanel();

    const connect = await screen.findByRole('button', { name: 'Connect' });
    const row = screen.getByLabelText('Address').closest('div[class*="dialRow"]');
    expect(row!.contains(connect)).toBe(true);
  });

  // Folding a section hides the sentence under the field it is about, and a client ID the server
  // refuses is exactly what a saved broker carries without anybody having opened the fold.
  it('opens the fold holding a field the server named', async () => {
    server.use(
      http.post('/api/connection', () =>
        HttpResponse.json(
          { title: 'Invalid', errors: { ClientId: ['Client ID is already taken.'] } },
          { status: 400 },
        ),
      ),
    );
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(fold('Sign-in').open).toBe(true));
    expect(screen.getByText('Client ID is already taken.')).toBeInTheDocument();
  });

  // Auto offers 5.0, then 3.1.1, then 3.1, and keeps the first the broker takes. The reader is
  // the wrong person to ask which their broker speaks, so they are not asked.
  it('never asks which MQTT to speak', async () => {
    renderPanel();

    await screen.findByRole('button', { name: 'Connect' });
    expect(screen.queryByText('MQTT version')).not.toBeInTheDocument();
  });

  it('speaks whichever the broker takes', async () => {
    let sent: Record<string, unknown> | undefined;
    server.use(
      http.post('/api/connection', async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ state: 'Connected' });
      }),
    );

    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(sent).toMatchObject({ protocolVersion: 'auto' }));
  });

  // The link is not asked for, it is reported — and over a live link there is nothing else on the
  // panel to report it under. It read last for a release, under a form of four hundred lines of
  // question every one of which the connection had already answered.
  it('leads with the live link, and the form is gone', async () => {
    connected();
    renderPanel();

    const details = await screen.findByLabelText('Connection details');

    expect(screen.queryByLabelText('Address')).not.toBeInTheDocument();
    // The two things left to do about a link that exists, both after the facts about it.
    for (const name of ['Save', 'Disconnect'])
      expect(details.compareDocumentPosition(screen.getByRole('button', { name }))).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
  });

  /**
   * The switch is a setting, and a setting about a thing that is not happening is clutter.
   *
   * It stands beside the Subscription section's own boxes, which are the same kind of answer — what
   * this console should do around the connection, as opposed to what the connection is made of —
   * and it is only ever on screen while there is no link. Over one, the panel's whole job is to
   * report what is up, and this would have been the only control on it.
   */
  it('offers auto-reconnect with the form, and only there', async () => {
    renderPanel();

    expect(
      await screen.findByRole('checkbox', { name: /Reconnect automatically/ }),
    ).toBeInTheDocument();
  });

  it('takes auto-reconnect away over a live link', async () => {
    connected();
    renderPanel();

    await screen.findByLabelText('Connection details');
    expect(
      screen.queryByRole('checkbox', { name: /Reconnect automatically/ }),
    ).not.toBeInTheDocument();
  });

  // Saving is offered on both faces: the moment a broker has connected is the moment it is most
  // obviously worth keeping, and the box that asks for the name has to come with it.
  it('can still name and keep the broker it is connected to', async () => {
    connected();
    renderPanel();

    await screen.findByLabelText('Connection details');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByLabelText('Save as')).toBeInTheDocument();
  });

  // A live link is the one thing this panel cannot connect over, so the button that would is
  // not on screen at all. Greyed, it was a control that had to say why it would not move.
  it('takes Connect away while a link is up', async () => {
    connected();
    renderPanel();

    await screen.findByLabelText('Connection details');

    expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
  });
});

// Every broker's own documentation hands you one string. Taking it apart into a scheme, a host,
// a port and a path is the first thing anyone does here and the easiest to get wrong, so the
// box does it. The splitting itself is covered in address.test.ts; this is the wiring.
describe('an address dropped into the Address box', () => {
  it('fills the scheme, the port and the path from a pasted URL', async () => {
    renderPanel();

    const address = await screen.findByLabelText('Address');
    await userEvent.clear(address);
    await userEvent.paste('wss://broker.emqx.io:8084/mqtt');

    expect(address).toHaveValue('broker.emqx.io');
    expect(screen.getByLabelText('Port')).toHaveValue(8084);
    expect(chosenWay()).toBe('wss');
    expect(screen.getByLabelText('WebSocket path')).toHaveValue('/mqtt');
  });

  it('splits a host and port typed by hand once the box is left', async () => {
    renderPanel();

    const address = await screen.findByLabelText('Address');
    await userEvent.clear(address);
    await userEvent.type(address, 'broker.example:8883');
    fireEvent.blur(address);

    await waitFor(() => expect(address).toHaveValue('broker.example'));
    expect(screen.getByLabelText('Port')).toHaveValue(8883);
    // The port it named answers the encryption question too, the same as one typed into the box.
    expect(chosenWay()).toBe('mqtts');
  });

  // A hostname is not an address to take apart, and nothing else about the connection moves.
  it('leaves a plain hostname exactly where it was typed', async () => {
    renderPanel();

    const address = await screen.findByLabelText('Address');
    await userEvent.clear(address);
    await userEvent.type(address, 'broker.example');
    fireEvent.blur(address);

    expect(address).toHaveValue('broker.example');
    expect(screen.getByLabelText('Port')).toHaveValue(1883);
    expect(chosenWay()).toBe('mqtt');
  });
});

// The panel's own question, in the order it now arrives: the address is what the reader has,
// and the way in is answered beside it rather than in front of it.
describe('the address the panel leads with', () => {
  const address = () => screen.getByLabelText('Address');

  // A box showing one broker while the attempt goes to another is the bug this guards. Connect
  // reconciles the text itself rather than trusting the blur to have landed first.
  //
  // fireEvent.click, not userEvent.click: userEvent moves focus and would fire the blur this
  // test exists to do without. With fireEvent the box is still focused and still unreconciled
  // when the button is pressed, which is the state a keyboard can also reach.
  it('connects to what the box says, with the box never left', async () => {
    let sent: Record<string, unknown> | undefined;
    server.use(
      http.post('/api/connection', async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ state: 'Connected' });
      }),
    );

    renderPanel();
    await userEvent.clear(address());
    await userEvent.type(address(), 'mqtts://broker.example:8883');
    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }));

    await waitFor(() =>
      expect(sent).toMatchObject({ host: 'broker.example', port: 8883, useTls: true }),
    );
  });
});

// The half of the inference that was missing: portFor has moved the port with the scheme since
// the picker was written, and nothing moved the scheme with the port.
describe('a port that implies a scheme', () => {
  const port = () => screen.getByLabelText('Port');

  const typePort = async (value: string) => {
    await userEvent.clear(port());
    await userEvent.type(port(), value);
    fireEvent.blur(port());
  };

  it('turns encryption on for the encrypted port', async () => {
    renderPanel();
    await typePort('8883');

    await waitFor(() => expect(chosenWay()).toBe('mqtts'));
  });

  it('turns it off again for the plain port', async () => {
    renderPanel();
    await pickWay('mqtts');
    await typePort('1883');

    await waitFor(() => expect(chosenWay()).toBe('mqtt'));
  });

  // 8883 typed a digit at a time passes through 8, 88 and 888. A scheme moving on each of them
  // would land wherever the last keystroke left it, which is why this waits for the box to be
  // left rather than reading the keystroke.
  it('waits for the box to be left rather than moving mid-number', async () => {
    renderPanel();
    await userEvent.clear(port());
    await userEvent.type(port(), '8883');

    expect(chosenWay()).toBe('mqtt');

    fireEvent.blur(port());
    await waitFor(() => expect(chosenWay()).toBe('mqtts'));
  });

  it('leaves a lab broker on a strange port where it was put', async () => {
    renderPanel();
    await typePort('21883');

    expect(chosenWay()).toBe('mqtt');
  });

  // Somebody over a WebSocket picked it deliberately, and 8883 over wss is a real broker. The
  // port may answer the encryption question; it may never move the link off the transport.
  it('never crosses the transport', async () => {
    renderPanel();
    await pickWay('wss');
    await typePort('8883');

    expect(chosenWay()).toBe('wss');
  });
});

// Four names are two questions multiplied together. They were asked as two controls — a transport
// and a tick box — and the trouble was that nothing said the two multiplied, or that either moved
// the port. One box of four at the head of the address asks it once; the API is still sent the
// two answers it has always kept apart.
describe('the way in, as one box of four', () => {
  it('offers the four ways in, written the way an address writes them', () => {
    renderPanel();

    expect([...protocol().querySelectorAll('option')].map((o) => o.textContent)).toEqual([
      'mqtt://',
      'mqtts://',
      'ws://',
      'wss://',
    ]);
  });

  it('starts on plain MQTT, which is what a broker of your own usually is', () => {
    renderPanel();

    expect(chosenWay()).toBe('mqtt');
    expect(screen.getByLabelText('Port')).toHaveValue(1883);
  });

  // The API has always kept the two apart, and still is sent them that way.
  it('sends the one answer as a transport and a TLS flag', async () => {
    let sent: Record<string, unknown> | undefined;
    server.use(
      http.post('/api/connection', async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ state: 'Connected' });
      }),
    );

    renderPanel();
    await pickWay('wss');
    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(sent).toMatchObject({ transport: 'webSocket', useTls: true }));
  });

  it('moves the port with the way in, while the port is still a default', async () => {
    renderPanel();
    await pickWay('mqtts');
    expect(screen.getByLabelText('Port')).toHaveValue(8883);

    await pickWay('wss');
    expect(screen.getByLabelText('Port')).toHaveValue(8084);
  });

  it('leaves a port somebody typed exactly where they typed it', async () => {
    renderPanel();
    const port = screen.getByLabelText('Port');
    await userEvent.clear(port);
    await userEvent.type(port, '21883');
    await pickWay('mqtts');

    expect(port).toHaveValue(21883);
  });

  it('asks for a path only where there is a WebSocket to put it on', async () => {
    renderPanel();
    expect(screen.queryByLabelText('WebSocket path')).not.toBeInTheDocument();

    await pickWay('ws');
    expect(screen.getByLabelText('WebSocket path')).toBeInTheDocument();
  });

  // A pasted address still answers it, which is the point of taking it whole.
  it('reads the way in off a pasted address', async () => {
    renderPanel();
    const address = screen.getByLabelText('Address');
    await userEvent.clear(address);
    await userEvent.paste('wss://broker.emqx.io:8084/mqtt');

    expect(chosenWay()).toBe('wss');
    expect(address).toHaveValue('broker.emqx.io');
  });

  // Where a scheme stands in a URL: at the head of the bar the host and the port are in.
  it('stands at the head of the address it belongs to', () => {
    renderPanel();

    const bar = screen.getByLabelText('Address').parentElement!;
    expect(bar.firstElementChild).toBe(protocol());
  });
});

// One rule for the whole of Security: its fields follow the way in. Under a plain scheme the
// server is never shown any of this — buildConnectRequest sends tls: null and ConfigureTls is
// only reached when UseTls — so with encryption off these controls do nothing whatever they
// hold, and they say so.
describe('the security sheet, which follows the way in', () => {
  const encrypt = () => pickWay('mqtts');
  const plain = () => pickWay('mqtt');
  const openFold = () => userEvent.click(screen.getByRole('button', { name: 'Security' }));

  it('offers the sheet whether or not encryption is on yet', () => {
    renderPanel();

    expect(screen.getByRole('button', { name: 'Security' })).toBeInTheDocument();
  });

  // Reading what a connection could be given is never blocked, only writing it. So the sheet
  // opens, the fold inside it opens, and every field in both is held.
  it('opens with encryption off and holds every field in it', async () => {
    renderPanel();
    await openFold();

    expect(screen.getByText('mqtt:// is not encrypted, so none of this is sent.')).toBeVisible();
    expect(screen.getByLabelText('Accept any certificate')).toBeDisabled();
    expect(screen.getByLabelText('Also trust my own CA')).toBeDisabled();
    expect(screen.getByLabelText('Client certificate')).toBeDisabled();

    await userEvent.click(screen.getByText('Server name and ALPN'));
    expect(screen.getByLabelText('Server name')).toBeDisabled();
    expect(screen.getByLabelText('ALPN protocol')).toBeDisabled();
  });

  it('gives every field back when the way in is an encrypted one', async () => {
    renderPanel();
    await openFold();
    await encrypt();

    expect(screen.getByLabelText('Accept any certificate')).toBeEnabled();
    expect(screen.getByLabelText('Also trust my own CA')).toBeEnabled();
    expect(screen.getByLabelText('Client certificate')).toBeEnabled();
  });

  // The ways in are the way back on, so they are outside the rule they govern.
  it('never holds the way in itself', async () => {
    renderPanel();
    expect(protocol()).toBeEnabled();

    await encrypt();
    expect(protocol()).toBeEnabled();

    await plain();
    expect(protocol()).toBeEnabled();
  });

  // The whole line is the one thing to press: nothing stands beside it that does something else.
  it('offers nothing beside the line but the line', async () => {
    renderPanel();

    const line = await screen.findByRole('button', { name: 'Security' });
    expect(line.parentElement!.querySelectorAll(':scope > button')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /^Use / })).not.toBeInTheDocument();
  });

  it('sends the certificate it was given', async () => {
    let sent: Record<string, unknown> | undefined;
    server.use(
      http.post('/api/connection', async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ state: 'Connected' });
      }),
      http.post('/api/subscriptions', () => new HttpResponse(null, { status: 202 })),
    );

    renderPanel();
    await encrypt();
    await userEvent.type(screen.getByLabelText('Client certificate'), '/tmp/client.pem');
    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));

    await waitFor(() =>
      expect(sent).toMatchObject({
        useTls: true,
        tls: expect.objectContaining({ clientCertificatePath: '/tmp/client.pem' }),
      }),
    );
  });

  // What makes the rule safe in the other direction: a certificate left in a box under a plain
  // connection is not sent rather than sent against a connection that could not use it.
  it('sends no certificate at all once encryption is turned off', async () => {
    let sent: Record<string, unknown> | undefined;
    server.use(
      http.post('/api/connection', async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ state: 'Connected' });
      }),
      http.post('/api/subscriptions', () => new HttpResponse(null, { status: 202 })),
    );

    renderPanel();
    await encrypt();
    await userEvent.type(screen.getByLabelText('Client certificate'), '/tmp/client.pem');
    await plain();
    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(sent).toMatchObject({ useTls: false, tls: null }));
  });
});

// A path is the only thing these boxes can hold — the connection is held by the server, so a
// certificate is opened where that server runs, and a file input would hand over the bytes with
// the path hidden. Where the host owns a window it owns a dialog that can name one, and where it
// does not there is nothing to press.
describe('a certificate pointed at rather than typed', () => {
  // The default handler in test/server.ts answers as a browser does: no window, no dialog.
  const dialog = (answers: Array<string | null>) => {
    const asked: string[] = [];
    server.use(
      http.get('/api/connection/certificate-file', () => HttpResponse.json({ canChoose: true })),
      http.post('/api/connection/certificate-file', async ({ request }) => {
        const { kind } = (await request.json()) as { kind: string };
        asked.push(kind);
        return HttpResponse.json({ path: answers.shift() ?? null });
      }),
    );

    return asked;
  };

  // The buttons stand beside the fields, inside the sheet, so they follow the way in like
  // everything else in there.
  const encrypt = async () => {
    await userEvent.selectOptions(await screen.findByLabelText('Protocol'), 'mqtts');
    await userEvent.click(screen.getByRole('button', { name: 'Security' }));
  };

  it('offers nothing to press where the host has no dialog', async () => {
    renderPanel();
    await screen.findByLabelText('Client certificate');

    expect(screen.queryByRole('button', { name: /^Choose /i })).not.toBeInTheDocument();
  });

  it('fills the box with the file the dialog named', async () => {
    dialog(['/Users/me/certs/client.pfx']);
    renderPanel();
    await encrypt();

    await userEvent.click(await screen.findByRole('button', { name: 'Choose Client certificate' }));

    await waitFor(() =>
      expect(screen.getByLabelText('Client certificate')).toHaveValue('/Users/me/certs/client.pfx'),
    );
    // Naming a certificate is a statement that this connection is encrypted, whichever way it
    // was named.
    expect(chosenWay()).toBe('mqtts');
  });

  it('asks for the field the button stands beside', async () => {
    const asked = dialog(['/tmp/ca.crt']);
    renderPanel();
    await encrypt();
    // The path is asked for by the one answer it belongs to.
    await userEvent.click(screen.getByLabelText('Also trust my own CA'));

    await userEvent.click(await screen.findByRole('button', { name: 'Choose Extra CA certificate' }));

    await waitFor(() => expect(asked).toEqual(['authority']));
  });

  // The private key only exists once there is a certificate that does not carry its own, which
  // is also the only state its button can be pressed in.
  it('offers the key once a certificate that needs one is named', async () => {
    const asked = dialog(['/tmp/client.pem', '/tmp/client.key']);
    renderPanel();
    await encrypt();

    await userEvent.click(await screen.findByRole('button', { name: 'Choose Client certificate' }));
    await screen.findByLabelText('Private key');
    await userEvent.click(screen.getByRole('button', { name: 'Choose Private key' }));

    await waitFor(() => expect(screen.getByLabelText('Private key')).toHaveValue('/tmp/client.key'));
    expect(asked).toEqual(['certificate', 'key']);
  });

  // Dismissing is 'not that one, then'. A reader who opened the dialog to look and thought better
  // of it would otherwise find the box they never meant to touch emptied.
  it('leaves the box alone when the dialog is dismissed', async () => {
    dialog([null]);
    renderPanel();
    await encrypt();
    const box = await screen.findByLabelText('Client certificate');
    await userEvent.type(box, '/tmp/already-here.pfx');

    await userEvent.click(screen.getByRole('button', { name: 'Choose Client certificate' }));

    await waitFor(() => expect(box).toHaveValue('/tmp/already-here.pfx'));
  });

  // One dialog at a time is the host's rule — the other console this app exists to be opened on
  // has one too — so the buttons say so rather than failing when they are pressed.
  it('holds every button while a dialog is open', async () => {
    server.use(
      http.get('/api/connection/certificate-file', () => HttpResponse.json({ canChoose: true })),
      http.post('/api/connection/certificate-file', async () => {
        await delay('infinite');
        return HttpResponse.json({ path: null });
      }),
    );
    renderPanel();
    await encrypt();
    await userEvent.click(screen.getByLabelText('Also trust my own CA'));

    await userEvent.click(await screen.findByRole('button', { name: 'Choose Client certificate' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Choose Extra CA certificate' })).toBeDisabled(),
    );
  });
});

// The box asks for every topic, and a good many brokers out on the internet will not give you
// every topic — one of them by closing the session. That used to be guarded against with a
// filter field beside the box. It is answered where it happens instead.
describe('a broker that will not give you everything', () => {
  const faulted = (reason: string) =>
    server.use(
      http.get('/api/connection', () =>
        HttpResponse.json({
          state: 'Faulted',
          failure: {
            reason,
            host: 'mqtt.hsl.fi',
            port: 8883,
            clientId: 'console',
            useTls: true,
            transport: 'tcp',
            protocolVersion: 'auto',
          },
        }),
      ),
    );

  it('asks for everything, and says so in the first line of the list', () => {
    renderPanel();

    expect(screen.getByLabelText(/^# all topics/)).toBeChecked();
    expect(listed()).toEqual(['#']);
  });

  it('subscribes to # when the box is ticked', async () => {
    let asked: unknown;
    server.use(
      http.post('/api/connection', () => HttpResponse.json({ state: 'Connected' })),
      http.post('/api/subscriptions', async ({ request }) => {
        asked = await request.json();
        return new HttpResponse(null, { status: 202 });
      }),
    );

    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(asked).toEqual({ topicFilter: '#', qos: 2 }));
  });

  it('asks for nothing when it is not', async () => {
    let asked = false;
    server.use(
      http.post('/api/connection', () => HttpResponse.json({ state: 'Connected' })),
      http.post('/api/subscriptions', () => {
        asked = true;
        return new HttpResponse(null, { status: 202 });
      }),
    );

    renderPanel();
    await userEvent.click(screen.getByLabelText(/^# all topics/));
    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled());
    expect(asked).toBe(false);
  });

  // A refused filter is a sentence and nothing to press. There used to be a button here that
  // opened Filters, and it is gone: the sentence says what the broker would not give, and the
  // Filters panel is one click away in the rail, where every panel is.
  it.each(['filterRefused', 'notPermitted', 'credentialsRejected'])(
    'reports %s as a sentence, with nothing to press under it',
    async (reason) => {
      faulted(reason);
      renderPanel();

      expect(await screen.findByRole('alert')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Filters/ })).not.toBeInTheDocument();
    },
  );
});

// The section at the foot used to hold eleven brokers somebody else runs. These are the ones the
// reader kept, which is the whole difference: a list nobody wrote but them.
// MQTT allows one client of a given ID on a broker at a time, and every install used to suggest
// the same one — so two MQTTForges on one broker took the link from each other for ever.
describe('the client ID a fresh form suggests', () => {
  it('takes the suffix this install keeps', async () => {
    server.use(
      http.get('/api/connection/defaults', () =>
        HttpResponse.json({ clientId: 'mqttforge-console-a7f3' }),
      ),
    );
    renderPanel();

    await waitFor(() =>
      expect(screen.getByLabelText('Client ID')).toHaveValue('mqttforge-console-a7f3'),
    );
  });

  // A box the reader has typed into is theirs, whatever answer arrives a beat later.
  it('leaves a client ID the reader typed alone', async () => {
    server.use(
      http.get('/api/connection/defaults', async () => {
        await delay(50);
        return HttpResponse.json({ clientId: 'mqttforge-console-a7f3' });
      }),
    );
    renderPanel();

    const box = await screen.findByLabelText('Client ID');
    await userEvent.clear(box);
    await userEvent.type(box, 'plant-monitor');

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(box).toHaveValue('plant-monitor');
  });
});

describe('the brokers you keep', () => {
  const savedProfile = (name: string, over: Record<string, unknown> = {}) => ({
    name,
    connection: savedConnection(over),
  });

  const withProfiles = (...profiles: unknown[]) =>
    server.use(http.get('/api/connection/profiles', () => HttpResponse.json(profiles)));

  it('shows nothing at all until something has been kept', async () => {
    renderPanel();

    await screen.findByRole('button', { name: 'Connect' });
    expect(screen.queryByRole('group', { name: 'Saved' })).not.toBeInTheDocument();
  });

  // In a column of their own down the left of the page, rather than under the form they fill: the
  // form stays the length of its own questions however many brokers have been kept.
  it('stands in a column of its own, beside the form', async () => {
    withProfiles(savedProfile('Lab broker'));
    renderPanel();

    const kept = await screen.findByRole('group', { name: 'Saved' });
    const form = screen.getByLabelText('Address').closest('div[class*="form"]');

    expect(form).not.toBeNull();
    expect(form!.contains(kept)).toBe(false);
    expect(kept.closest('aside')).toBe(screen.getByRole('complementary', { name: 'Brokers' }));
  });

  it('names each one, and offers to dial it', async () => {
    withProfiles(savedProfile('Lab broker'), savedProfile('Staging'));
    renderPanel();

    expect(await screen.findByRole('button', { name: /^Lab broker/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect to Staging' })).toBeInTheDocument();
    // Nothing on a card forgets it. That is asked at the head of the form, about the broker the
    // form is holding — a cross a few pixels from the mark that connects took the only copy of
    // something typed by hand.
    expect(screen.queryByRole('button', { name: /^Forget/ })).not.toBeInTheDocument();
  });

  it('keeps what is on screen, under the name that was typed', async () => {
    let sent: Record<string, unknown> | undefined;
    server.use(
      http.put('/api/connection/profiles', async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderPanel();

    const address = await screen.findByLabelText('Address');
    await userEvent.clear(address);
    await userEvent.type(address, 'mqtts://lab.example:8883');
    await userEvent.click(screen.getByRole('button', { name: 'Save as…' }));

    const name = screen.getByLabelText('Save as');
    await userEvent.clear(name);
    await userEvent.type(name, 'Lab broker');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(sent).toMatchObject({ name: 'Lab broker' }));
    // Through the same reconciliation Connect goes through, so the box's text is what is kept.
    expect(sent).toMatchObject({
      connection: expect.objectContaining({ host: 'lab.example', port: 8883, useTls: true }),
    });
  });

  // Somebody with one broker would have typed the address anyway.
  it('offers the address as the name', async () => {
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'Save as…' }));

    expect(screen.getByLabelText('Save as')).toHaveValue('localhost:1883');
  });

  it('gives up on Cancel without asking anything', async () => {
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'Save as…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByLabelText('Save as')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save as…' })).toBeInTheDocument();
  });

  it('will not keep one under no name at all', async () => {
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'Save as…' }));
    await userEvent.clear(screen.getByLabelText('Save as'));

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('fills the form from a chip', async () => {
    withProfiles(savedProfile('Lab broker', { host: 'lab.example', port: 8883, useTls: true }));
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: /^Lab broker/ }));

    expect(screen.getByLabelText('Address')).toHaveValue('lab.example');
    expect(screen.getByLabelText('Port')).toHaveValue(8883);
    expect(chosenWay()).toBe('mqtts');
  });

  // Derived, not remembered: type over the address and the chip goes out by itself.
  it('stops marking the chip once the form is no longer that broker', async () => {
    withProfiles(savedProfile('Lab broker', { host: 'lab.example' }));
    renderPanel();

    const chip = await screen.findByRole('button', { name: /^Lab broker/ });
    await userEvent.click(chip);
    expect(chip.closest('div[class*="chip"]')).toHaveAttribute('data-active');

    const address = screen.getByLabelText('Address');
    await userEvent.clear(address);
    await userEvent.type(address, 'somewhere.else');
    fireEvent.blur(address);

    await waitFor(() => expect(chip.closest('div[class*="chip"]')).not.toHaveAttribute('data-active'));
  });

  it('forgets the one the form is holding', async () => {
    let deleted: string | undefined;
    withProfiles(savedProfile('Lab broker'));
    server.use(
      http.delete('/api/connection/profiles/:name', ({ params }) => {
        deleted = params.name as string;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: /^Lab broker/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Forget Lab broker' }));

    await waitFor(() => expect(deleted).toBe('Lab broker'));
  });
});

// Seven fields, but not seven at once: a key and a password are for a certificate, and a
// certificate in a .pfx carries its own key.
describe('the encryption fields, as far as they apply', () => {
  // Over an encrypted way in: the sheet's fields follow it, and a field that cannot be typed
  // into cannot show what typing into it reveals.
  const openEncryption = async () => {
    renderPanel();
    await userEvent.selectOptions(await screen.findByLabelText('Protocol'), 'mqtts');
    await userEvent.click(screen.getByRole('button', { name: 'Security' }));
  };

  it('asks for a certificate before asking anything about one', async () => {
    await openEncryption();

    expect(screen.getByLabelText('Client certificate')).toBeInTheDocument();
    expect(screen.queryByLabelText('Private key')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Certificate password')).not.toBeInTheDocument();
  });

  it('asks for the key and the password once there is a certificate', async () => {
    await openEncryption();
    await userEvent.type(screen.getByLabelText('Client certificate'), '/etc/client.crt');

    expect(screen.getByLabelText('Private key')).toBeInTheDocument();
    expect(screen.getByLabelText('Certificate password')).toBeInTheDocument();
  });

  // A .pfx carries its own key. Asking for one beside it is asking for a file nobody has.
  it.each(['/etc/client.pfx', '/etc/client.P12'])('asks for no key beside %s', async (path) => {
    await openEncryption();
    await userEvent.type(screen.getByLabelText('Client certificate'), path);

    expect(screen.queryByLabelText('Private key')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Certificate password')).toBeInTheDocument();
  });

  // Neither is about a certificate, and neither is asked for by a broker you reach at its own
  // address on its own port. Kept, because without ALPN there is no reaching AWS IoT on 443.
  it('keeps the server name and ALPN behind a line of their own', async () => {
    await openEncryption();

    expect(screen.getByText('Server name and ALPN')).toBeInTheDocument();
    expect(screen.getByLabelText('ALPN protocol')).toBeInTheDocument();
  });
});

/**
 * The Topics on connect sheet: one list, drawn as the things in it.
 *
 * The two answers nearly everybody wants are ticks and every other filter is a chip. A tick says
 * whether its filter is in the list, and pressing it puts the filter in or takes it out — so
 * there is nothing to keep in step and no way for two controls to disagree about the one answer
 * they both describe.
 */
describe('what to listen to the moment the link is up', () => {
  const everything = () => screen.getByLabelText(/^# all topics/);
  const system = () => screen.getByLabelText(/^\$SYS\/# broker statistics/);
  const box = () => screen.getByLabelText('Add a topic filter');
  const add = (filters: string) => userEvent.type(box(), `${filters}{enter}`);

  /** Every filter the panel asked the server for, in the order it asked. */
  function watchAsks() {
    const asked: string[] = [];
    server.use(
      http.post('/api/connection', () => HttpResponse.json({ state: 'Connected' })),
      http.post('/api/subscriptions', async ({ request }) => {
        asked.push(((await request.json()) as { topicFilter: string }).topicFilter);
        return new HttpResponse(null, { status: 202 });
      }),
    );

    return asked;
  }

  it('opens asking for everything and nothing else', () => {
    renderPanel();

    expect(everything()).toBeChecked();
    expect(system()).not.toBeChecked();
    expect(listed()).toEqual(['#']);
  });

  it('puts a filter into the list when its tick is pressed, and takes it out again', async () => {
    renderPanel();

    await userEvent.click(system());
    expect(listed()).toEqual(['#', '$SYS/#']);

    await userEvent.click(system());
    expect(listed()).toEqual(['#']);
  });

  // A filter of the reader's own is a chip: there to be read, and with its own way out.
  it('draws a filter the reader wrote as a chip, and drops it from its cross', async () => {
    renderPanel();

    await add('plant/+/temp');
    expect(listed()).toEqual(['#', 'plant/+/temp']);
    // The box is ready for the next one rather than still holding the last.
    expect(box()).toHaveValue('');

    await userEvent.click(screen.getByLabelText('Remove plant/+/temp'));
    expect(listed()).toEqual(['#']);
  });

  // The rule the ticks exist under: they report the list rather than holding an opinion of their
  // own, so one of the two written into the box by hand ticks the box that stands for it.
  it('ticks a box when its filter is written into the list by hand', async () => {
    renderPanel();
    expect(system()).not.toBeChecked();

    await add('$SYS/#');

    expect(system()).toBeChecked();
    expect(listed()).toEqual(['#', '$SYS/#']);
  });

  // Enter in this box means 'that one, and another' — the form's own Enter is Connect, and a
  // reader halfway through a list has not finished saying what to connect with.
  it('adds on Enter without dialling', async () => {
    let dialled = false;
    server.use(
      http.post('/api/connection', () => {
        dialled = true;
        return HttpResponse.json({ state: 'Connected' });
      }),
    );
    renderPanel();

    await add('lab/oven/#');

    expect(listed()).toEqual(['#', 'lab/oven/#']);
    expect(dialled).toBe(false);
  });

  // Separated the way the Filters panel's own box separates them.
  it('takes several at once', async () => {
    renderPanel();

    await add('plant/+/temp, lab/oven/#');

    expect(listed()).toEqual(['#', 'plant/+/temp', 'lab/oven/#']);
  });

  it('offers nothing to add while the box is empty', async () => {
    renderPanel();
    await userEvent.click(screen.getByRole('button', { name: 'Topics on connect' }));

    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();

    await userEvent.type(box(), 'a/b');
    expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled();
  });

  it('asks for what the reader wrote, in the order they wrote it', async () => {
    const asked = watchAsks();
    renderPanel();

    await userEvent.click(everything());
    await add('plant/+/temp');
    await add('lab/oven/#');
    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(asked).toEqual(['plant/+/temp', 'lab/oven/#']));
  });

  it('asks for nothing when the list is empty, and says so', async () => {
    const asked = watchAsks();
    renderPanel();

    await userEvent.click(everything());
    expect(screen.getByText('No filters — nothing is subscribed on connect.')).toBeInTheDocument();

    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled());
    expect(asked).toEqual([]);
  });

  // A filter written twice is one filter, the same way the Filters panel reads its own box.
  it('asks once for a filter written twice', async () => {
    const asked = watchAsks();
    renderPanel();

    await add('#');
    expect(listed()).toEqual(['#']);
    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(asked).toEqual(['#']));
  });
});

/**
 * The list survives a reload, because it is saved with the rest of the settings.
 *
 * Two checkboxes were state the panel forgot on every load, and nobody minded because the answer
 * was one of two. A list somebody typed is work, and work the console loses is work nobody does
 * twice.
 */
describe('the subscription list, remembered', () => {
  const saved = (subscriptions: string[] | null) =>
    server.use(
      http.get('/api/connection/settings', () =>
        HttpResponse.json({
          host: 'broker.example',
          port: 1883,
          clientId: 'console',
          username: null,
          hasPassword: false,
          useTls: false,
          transport: 'tcp',
          protocolVersion: 'auto',
          webSocketPath: null,
          cleanSession: true,
          sessionExpiryInterval: null,
          tls: null,
          subscriptions,
        }),
      ),
    );

  it('comes back as it was written', async () => {
    saved(['plant/+/temp', '$SYS/#']);
    renderPanel();

    // The tick first and the chip after it: that is the order they are drawn in, not the order
    // they are asked for in, which is the order they were written.
    await waitFor(() => expect(listed()).toEqual(['$SYS/#', 'plant/+/temp']));
    expect(screen.getByLabelText(/^\$SYS\/# broker statistics/)).toBeChecked();
    expect(screen.getByLabelText(/^# all topics/)).not.toBeChecked();
  });

  // Settings written before the list existed. The console asked for '#' then, so that is what
  // they meant — an empty list would silently stop a saved broker listening to anything.
  it('reads a settings file that predates it as the old default', async () => {
    saved(null);
    renderPanel();

    await waitFor(() => expect(screen.getByLabelText('Address')).toHaveValue('broker.example'));
    expect(listed()).toEqual(['#']);
  });

  // And empty is a real answer, kept as one.
  it('keeps an empty list empty', async () => {
    saved([]);
    renderPanel();

    await waitFor(() => expect(listed()).toEqual([]));
  });

  it('sends the list with the connect, so the server keeps it', async () => {
    let sent: { subscriptions?: string[] } | undefined;
    server.use(
      http.post('/api/connection', async ({ request }) => {
        sent = (await request.json()) as { subscriptions?: string[] };
        return HttpResponse.json({ state: 'Connected' });
      }),
      http.post('/api/subscriptions', () => new HttpResponse(null, { status: 202 })),
    );
    renderPanel();

    await userEvent.click(await screen.findByLabelText(/^# all topics/));
    await userEvent.type(screen.getByLabelText('Add a topic filter'), 'lab/oven/#{enter}');
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(sent?.subscriptions).toEqual(['lab/oven/#']));
  });
});

/**
 * A saved broker says where it points.
 *
 * The name alone was a card you had to press to find out what it meant, and pressing it
 * overwrites the form — so the only way to read the list was to spend it.
 */
describe('what a saved broker shows', () => {
  const withProfiles = (...profiles: unknown[]) =>
    server.use(http.get('/api/connection/profiles', () => HttpResponse.json(profiles)));

  // The card is the name and nothing else; where it points is there for a pointer, written the
  // way the log writes one, so it can be found out without pressing the card.
  it('draws the name alone, and keeps the address for the pointer', async () => {
    withProfiles({
      name: 'Lab broker',
      connection: savedConnection({ host: 'lab.example', port: 8883, useTls: true }),
    });
    renderPanel();

    const card = await screen.findByRole('button', { name: 'Lab broker' });
    expect(card).toHaveTextContent(/^Lab broker$/);
    expect(card).toHaveAttribute('title', 'mqtts://lab.example:8883');
  });

  it('brackets an IPv6 host, so the port can still be found', async () => {
    withProfiles({ name: 'Six', connection: savedConnection({ host: '::1', port: 1883 }) });
    renderPanel();

    const card = await screen.findByRole('button', { name: 'Six' });
    expect(card).toHaveAttribute('title', 'mqtt://[::1]:1883');
  });
});

/**
 * The console's own server, not the broker's.
 *
 * The summary says the state in a sentence — 'lost its own server … everything here is the last
 * thing it heard' — and Disconnect went on being offered under it. Pressing it sent a request
 * nothing was going to answer, so the button disabled itself for the wait and stayed disabled:
 * a fetch to a server that accepts the connection and then says nothing does not fail, it waits.
 */
describe('the controls while the console has lost its own server', () => {
  afterEach(() => useHubStatusStore.setState({ status: 'live' }));

  /** A link that is up, as the API reports one. */
  const live = () =>
    server.use(
      http.get('/api/connection', () =>
        HttpResponse.json({
          state: 'Connected',
          connection: {
            host: 'broker.example',
            port: 1883,
            clientId: 'mqttforge-console',
            username: null,
            useTls: false,
            connectedAt: new Date().toISOString(),
            sessionPresent: false,
            assignedClientId: null,
            serverKeepAlive: null,
            transport: 'tcp',
            protocolVersion: 'v500',
          },
        }),
      ),
    );

  it('does not offer to end a link it cannot reach the server to end', async () => {
    live();
    useHubStatusStore.setState({ status: 'reconnecting' });
    renderPanel();

    const disconnect = await screen.findByRole('button', { name: 'Disconnect' });
    expect(disconnect).toBeDisabled();
    expect(disconnect).toHaveAttribute('title', expect.stringContaining('cannot reach its own server'));
  });

  it('offers it again the moment the server is back', async () => {
    live();
    renderPanel();

    expect(await screen.findByRole('button', { name: 'Disconnect' })).toBeEnabled();
  });
});

/**
 * What the panel says while it is dialling.
 *
 * A dial against a host that answers nothing runs for twenty seconds — the deadline on one
 * CONNECT — and for all twenty the panel was the form it had been, with Connect swapped for
 * Abort. A dial in progress and a form that ignored the press looked the same.
 */
describe('while an attempt is running', () => {
  const dialling = () => {
    let answer: (value: unknown) => void = () => {};
    const held = new Promise((resolve) => { answer = resolve; });
    server.use(
      http.get('/api/connection', () => HttpResponse.json({ state: 'Disconnected' })),
      http.post('/api/connection', async () => {
        await held;
        return HttpResponse.json({ state: 'Connected' });
      }),
    );

    return { answer };
  };

  // The connect runs on past the broker's yes while the subscriptions go out. The strip and the
  // button follow the link, not the request: it said 'Connecting to …' and offered Abort over a
  // link that was already up, until the subscriptions were done.
  it('says Connected the moment the link is up, while the connect is still finishing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const up = {
      state: 'Connected',
      connection: {
        host: 'localhost',
        port: 1883,
        clientId: 'mqttforge-console',
        username: null,
        useTls: false,
        connectedAt: new Date().toISOString(),
        sessionPresent: false,
        assignedClientId: null,
        serverKeepAlive: null,
        transport: 'tcp',
        protocolVersion: 'v500',
      },
    };
    let answered: Record<string, unknown> = { state: 'Disconnected' };
    server.use(
      http.get('/api/connection', () => HttpResponse.json(answered)),
      // Never answers: the subscriptions are still going out.
      http.post('/api/connection', () => new Promise<never>(() => {})),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderPanel(queryClient);

    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));
    expect(await screen.findByRole('button', { name: 'Abort' })).toBeInTheDocument();

    // As the hub would write it: the broker has said yes, the POST has not come back.
    answered = up;
    act(() => queryClient.setQueryData(queryKeys.connection, up));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAY_AFTER + 100);
    });

    expect(screen.getByRole('status')).toHaveTextContent('Connected to localhost:1883');
    expect(screen.queryByTestId('dialling')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Abort' })).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  // A failed dial is Connecting then Faulted over the hub. Miss the second and the strip went on
  // counting 'Connecting to … 35s' under the sentence saying nothing was listening.
  it('lets go of Connecting when the dial fails, even if the hub never says so', async () => {
    let answered: Record<string, unknown> = { state: 'Disconnected' };
    let refuse: () => void = () => {};
    const refused = new Promise<void>((resolve) => {
      refuse = resolve;
    });
    server.use(
      http.get('/api/connection', () => HttpResponse.json(answered)),
      http.post('/api/connection', async () => {
        await refused;
        return HttpResponse.json(
          { title: 'Could not connect to broker', detail: 'Refused.', reason: 'refused' },
          { status: 502 },
        );
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderPanel(queryClient);

    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));
    // The hub's first message lands; its second never does.
    act(() => queryClient.setQueryData(queryKeys.connection, { state: 'Connecting' }));
    answered = {
      state: 'Faulted',
      failure: { reason: 'refused', host: 'localhost', port: 1883 },
    };
    refuse();

    expect(await screen.findByRole('button', { name: 'Connect' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('dialling')).not.toBeInTheDocument());
    // The failure takes the strip's place of 'Not connected', in the same step.
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('names what it is dialling on the press, and counts once it has run long enough', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    dialling();
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));

    // At once: the press has taken, and the strip says so. The count waits, since under a
    // second it could only say 0s.
    const said = await screen.findByTestId('dialling');
    expect(said).toHaveTextContent('Connecting to localhost:1883');
    expect(said).not.toHaveTextContent(/· \d+s/);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAY_AFTER + 100);
    });

    expect(screen.getByTestId('dialling')).toHaveTextContent(/· \d+s/);
    vi.useRealTimers();
  });

  // Slow is not stuck, and over TLS a healthy dial can be slow: the certificate chain is fetched
  // and checked before the CONNECT goes. Said about a dial it is true of, once it has run long
  // enough for somebody to wonder — and never about a plain one.
  it.each([
    ['mqtts', true],
    ['mqtt', false],
  ] as const)('says a slow dial over %s is %s the certificate being checked', async (scheme, said) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    dialling();
    renderPanel();

    await userEvent.selectOptions(await screen.findByLabelText('Protocol'), scheme);
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(screen.queryByText(/certificate is checked/)).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAY_AFTER + 100);
    });
    await screen.findByTestId('dialling');

    expect(screen.queryAllByText(/certificate is checked/)).toHaveLength(said ? 1 : 0);
    vi.useRealTimers();
  });

  // The ordinary connect, which is over before a reader can look at it.
  it('says nothing at all about a dial that answers at once', async () => {
    server.use(
      http.get('/api/connection', () => HttpResponse.json({ state: 'Disconnected' })),
      http.post('/api/connection', () => HttpResponse.json({ state: 'Connected' })),
      http.post('/api/subscriptions', () => new HttpResponse(null, { status: 202 })),
    );
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));

    expect(screen.queryByTestId('dialling')).not.toBeInTheDocument();
  });

  it('says nothing once there is nothing being dialled', async () => {
    server.use(http.get('/api/connection', () => HttpResponse.json({ state: 'Disconnected' })));
    renderPanel();

    await screen.findByRole('button', { name: 'Connect' });
    expect(screen.queryByTestId('dialling')).not.toBeInTheDocument();
  });

  // The one control on the row is the one that stops it.
  it('offers Abort in place of Connect', async () => {
    dialling();
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));

    expect(await screen.findByRole('button', { name: 'Abort' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument();
  });
});

/**
 * What is on screen after the reader calls a dial off.
 *
 * A dial that is called off leaves the link exactly where it found it — which after one failed
 * attempt is Faulted, with that attempt's sentence. The panel put that sentence back at the
 * instant Abort was pressed, where it read as the abort's own result: a red line about a broker
 * that 'did not answer', arriving because the reader said stop.
 */
describe('after an attempt is called off', () => {
  const failsThenHangs = () => {
    let attempts = 0;
    let held: (value: unknown) => void = () => {};

    server.use(
      http.get('/api/connection', () =>
        HttpResponse.json(
          attempts === 0
            ? { state: 'Disconnected' }
            : { state: 'Faulted', failure: { reason: 'timeout', host: 'nowhere.example', port: 1883 } },
        ),
      ),
      http.post('/api/connection', async () => {
        attempts += 1;
        if (attempts === 1) {
          return HttpResponse.json(
            { title: 'Broker unreachable', detail: 'nowhere.example:1883 did not answer.', reason: 'timeout' },
            { status: 502 },
          );
        }

        await new Promise((resolve) => { held = resolve; });

        return HttpResponse.json(
          { title: 'Connect aborted', detail: 'The attempt was cancelled.', reason: 'aborted' },
          { status: 409 },
        );
      }),
      http.delete('/api/connection/attempt', () => {
        held(null);

        return new HttpResponse(null, { status: 204 });
      }),
    );
  };

  it('puts no red line back up about the attempt before it', async () => {
    failsThenHangs();
    renderPanel();

    // The first dial fails, and says so. The line is the panel's own alert, not the record's
    // copy of the same words — the record keeps every attempt, which is what it is for.
    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/did not answer|didn.t respond/i);

    // The second is called off.
    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Abort' }));

    await screen.findByRole('button', { name: 'Connect' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

/**
 * Save is an offer to keep something, and a thing already kept is not one.
 *
 * The button stood over a form filled straight off a saved card — the reader picks Lab mosquitto,
 * the form fills with it, and the panel offers to save what it has just been handed.
 */
describe('offering to keep a broker', () => {
  const kept = {
    name: 'Lab',
    connection: savedConnection({ host: 'broker.example', port: 1883, clientId: 'mqttforge-console' }),
  };

  const withProfiles = (...profiles: unknown[]) =>
    server.use(http.get('/api/connection/profiles', () => HttpResponse.json(profiles)));

  it('offers it for a form the console does not hold', async () => {
    withProfiles();
    renderPanel();

    expect(await screen.findByRole('button', { name: 'Save as…' })).toBeInTheDocument();
  });

  // A broker the console already holds is still offered: the same address under a second name or
  // a second client ID is a second thing to keep, and the reader should not have to edit a field
  // to be allowed to keep it.
  it('offers it for a form the console already holds', async () => {
    withProfiles(kept);
    server.use(http.get('/api/connection/settings', () => HttpResponse.json(kept.connection)));
    renderPanel();

    await screen.findByRole('button', { name: 'Connect' });
    expect(await screen.findByRole('button', { name: 'Save as…' })).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Client ID'), '-2');

    expect(await screen.findByRole('button', { name: 'Save as…' })).toBeInTheDocument();
  });
});

// The brokers this console reached, in the panel rather than on their own.
//
// What is worth testing here is the seam between the two lists: that a saved broker is drawn in
// both, and what pressing and forgetting a card do.
describe('the history above the saved brokers', () => {
  const recent = (over: Record<string, unknown> = {}) => ({
    id: 'abc123',
    connection: savedConnection({ subscriptions: ['#'] }),
    lastConnectedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    ...over,
  });

  const withHistory = (...brokers: unknown[]) =>
    server.use(http.get('/api/connection/recent', () => HttpResponse.json(brokers)));

  const withProfiles = (...profiles: unknown[]) =>
    server.use(http.get('/api/connection/profiles', () => HttpResponse.json(profiles)));

  // In columns of their own beside the form, and there without being asked for.
  it('shows the brokers and the record without a tab to press', async () => {
    withHistory(recent());
    renderPanel();

    expect(await screen.findByRole('group', { name: 'Recent' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Broker events' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Recent/ })).not.toBeInTheDocument();
  });

  // A bar at the foot, shut until it is pressed: the count and the newest line, then the rest.
  it('keeps the record to one line at the foot until it is opened', async () => {
    useBrokerEventsStore.getState().clear();
    useBrokerEventsStore.getState().push({ kind: 'ok', what: 'Connected' });
    useBrokerEventsStore.getState().push({ kind: 'fault', what: 'Link dropped' });
    renderPanel();

    const handle = await screen.findByRole('button', { name: /^Events/ });
    expect(handle).toHaveAttribute('aria-expanded', 'false');
    // Within the record: the brokers' column has a list of its own while it is empty.
    const record = within(screen.getByRole('region', { name: 'Broker events' }));
    expect(screen.getByText('Link dropped')).toBeInTheDocument();
    expect(record.queryByRole('listitem')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear the broker events' })).not.toBeInTheDocument();

    await userEvent.click(handle);

    expect(handle).toHaveAttribute('aria-expanded', 'true');
    expect(record.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Clear the broker events' })).toBeInTheDocument();
  });

  // Shut every time the panel is opened. It used to be remembered past the panel, so a record
  // opened once was open on every visit after it.
  it('starts with the record shut again when the panel is opened again', async () => {
    useBrokerEventsStore.getState().clear();
    useBrokerEventsStore.getState().push({ kind: 'ok', what: 'Connected' });
    const first = renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: /^Events/ }));
    expect(screen.getByRole('button', { name: /^Events/ })).toHaveAttribute('aria-expanded', 'true');

    first.unmount();
    renderPanel();

    expect(await screen.findByRole('button', { name: /^Events/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  // The arrow on a card is the card and Connect in one press: the form is filled and dialled.
  it('dials a card from its arrow', async () => {
    let sent: Record<string, unknown> | undefined;
    withHistory(
      recent({ connection: savedConnection({ host: 'reached.example', port: 8883, subscriptions: ['#'] }) }),
    );
    server.use(
      http.post('/api/connection', async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ state: 'Connected' });
      }),
      http.post('/api/subscriptions', () => new HttpResponse(null, { status: 202 })),
    );
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: /^Connect to .*reached\.example:8883/ }));

    await waitFor(() => expect(sent).toMatchObject({ host: 'reached.example', port: 8883 }));
    expect(screen.getByLabelText('Address')).toHaveValue('reached.example');
  });

  // Which saved broker a link was made from decides which colour and alert rules apply to it, so a
  // saved card says so in its connect; one reached and never kept is no saved broker at all.
  describe('which saved broker a connect is made from', () => {
    const capture = () => {
      const box: { sent?: Record<string, unknown> } = {};
      server.use(
        http.post('/api/connection', async ({ request }) => {
          box.sent = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({ state: 'Connected' });
        }),
        http.post('/api/subscriptions', () => new HttpResponse(null, { status: 202 })),
      );
      return box;
    };

    it('sends the saved broker a card dials', async () => {
      withProfiles({ id: 'lab-1', name: 'Lab', connection: savedConnection({ host: 'lab.example', subscriptions: [] }) });
      const box = capture();
      renderPanel();

      await userEvent.click(await screen.findByRole('button', { name: 'Connect to Lab' }));

      await waitFor(() => expect(box.sent).toMatchObject({ host: 'lab.example', profileId: 'lab-1' }));
    });

    it('sends none for a broker that was only reached', async () => {
      withHistory(recent({ connection: savedConnection({ host: 'reached.example', port: 8883, subscriptions: [] }) }));
      const box = capture();
      renderPanel();

      await userEvent.click(await screen.findByRole('button', { name: /^Connect to .*reached\.example:8883/ }));

      await waitFor(() => expect(box.sent).toMatchObject({ host: 'reached.example' }));
      expect(box.sent).not.toHaveProperty('profileId');
    });

    it('sends the saved broker the form was filled from', async () => {
      withProfiles({ id: 'lab-1', name: 'Lab', connection: savedConnection({ host: 'lab.example', subscriptions: [] }) });
      const box = capture();
      renderPanel();

      await userEvent.click(await screen.findByRole('button', { name: 'Lab' }));
      await userEvent.click(screen.getByRole('button', { name: 'Connect' }));

      await waitFor(() => expect(box.sent).toMatchObject({ host: 'lab.example', profileId: 'lab-1' }));
    });

    // Another address typed over a saved broker's is another broker, and that one's rules are not
    // this one's — even though the name over the form only lets go of it once the press is over.
    it('sends none once the address is not the saved broker any more', async () => {
      withProfiles({ id: 'lab-1', name: 'Lab', connection: savedConnection({ host: 'lab.example', subscriptions: [] }) });
      const box = capture();
      renderPanel();

      await userEvent.click(await screen.findByRole('button', { name: 'Lab' }));
      const address = screen.getByLabelText('Address');
      await userEvent.clear(address);
      await userEvent.type(address, 'elsewhere.example');
      await userEvent.click(screen.getByRole('button', { name: 'Connect' }));

      await waitFor(() => expect(box.sent).toMatchObject({ host: 'elsewhere.example' }));
      expect(box.sent).not.toHaveProperty('profileId');
    });
  });

  // What a sheet holds is the line's description: read out after its name, and not drawn.
  it('describes each line by what its sheet holds', async () => {
    renderPanel();

    const client = await screen.findByRole('button', { name: 'Sign-in' });
    expect(client).toHaveAccessibleDescription(/^anonymous · /);
    expect(screen.getByRole('button', { name: 'Topics on connect' })).toHaveAccessibleDescription('#');
    expect(screen.getByRole('button', { name: 'Security' })).toHaveAccessibleDescription('off');
  });

  it('draws a broker that was reached and never kept', async () => {
    withHistory(recent());
    renderPanel();

    expect(await screen.findByRole('heading', { name: 'Recent' })).toBeInTheDocument();
    expect(await screen.findByText('broker.example:1883')).toBeInTheDocument();
  });

  // A record of where the console has been. Keeping a broker is no reason to leave it out of that.
  it('draws a saved broker in both lists', async () => {
    withHistory(recent());
    withProfiles({ name: 'Lab', connection: savedConnection({ subscriptions: ['#'] }) });
    renderPanel();

    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Recent' })).toBeInTheDocument();

    const history = screen.getByRole('group', { name: 'Recent' });
    expect(within(history).getByText('broker.example:1883')).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Saved' })).getByText('Lab')).toBeInTheDocument();
  });

  it('fills the form from a card', async () => {
    withHistory(recent({ connection: savedConnection({ host: 'reached.example', port: 8883, subscriptions: ['#'] }) }));
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: /^reached\.example/ }));

    expect(screen.getByLabelText('Address')).toHaveValue('reached.example');
    expect(screen.getByLabelText('Port')).toHaveValue(8883);
  });

  it('forgets one by its id', async () => {
    const forgotten: string[] = [];
    withHistory(recent());
    server.use(
      http.delete('/api/connection/recent/:id', ({ params }) => {
        forgotten.push(String(params.id));
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderPanel();

    // The card first: Forget is about the broker the form is holding.
    await userEvent.click(await screen.findByRole('button', { name: /^broker\.example:1883/ }));
    await userEvent.click(screen.getByRole('button', { name: /^Forget mqtt:\/\/broker\.example/ }));

    await waitFor(() => expect(forgotten).toEqual(['abc123']));
  });
});

/**
 * What the form is holding, said over it — and the three things that can be done to it as a
 * thing: keep what was changed, keep it under a name, forget it.
 *
 * They stood in the list: a Save at its head, a column away from what was being saved, and a
 * cross on every card a few pixels from the mark that connects.
 */
describe('the broker the form is holding', () => {
  const profile = (name: string, over: Record<string, unknown> = {}) => ({
    name,
    connection: savedConnection({ subscriptions: ['#'], ...over }),
  });

  const withProfiles = (...profiles: unknown[]) =>
    server.use(http.get('/api/connection/profiles', () => HttpResponse.json(profiles)));

  const subject = () => screen.getByRole('heading', { level: 4 });
  const tag = () => subject().nextElementSibling;

  const savesTo = () => {
    const sent: Array<{ name: string; connection: Record<string, unknown> }> = [];
    server.use(
      http.put('/api/connection/profiles', async ({ request }) => {
        sent.push((await request.json()) as (typeof sent)[number]);
        return new HttpResponse(null, { status: 204 });
      }),
    );

    return sent;
  };

  it('calls a form nobody has kept a new connection', async () => {
    renderPanel();

    await screen.findByRole('button', { name: 'Connect' });
    expect(subject()).toHaveTextContent('New connection');
    expect(tag()).toHaveTextContent('Not saved');
    // Nothing to forget and nothing changed: the one offer is to keep it.
    expect(screen.queryByRole('button', { name: /^Forget/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save as…' })).toBeInTheDocument();
  });

  it('names a saved broker once its card is pressed', async () => {
    withProfiles(profile('Lab', { host: 'lab.example' }));
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: /^Lab/ }));

    expect(subject()).toHaveTextContent('Lab');
    expect(tag()).toHaveTextContent('Saved');
    // Kept exactly as it stands, so there is nothing to save again.
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
  });

  it('names one out of the history by its address, which is the only name it has', async () => {
    server.use(
      http.get('/api/connection/recent', () =>
        HttpResponse.json([
          {
            id: 'abc123',
            connection: savedConnection({ host: 'reached.example', subscriptions: ['#'] }),
            lastConnectedAt: new Date().toISOString(),
          },
        ]),
      ),
    );
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: /^reached\.example/ }));

    expect(subject()).toHaveTextContent('reached.example:1883');
    expect(tag()).toHaveTextContent('Recent');
  });

  // The name is not in question, so it is not asked for again.
  it('keeps what was changed under the name it already has, in one press', async () => {
    const sent = savesTo();
    withProfiles(profile('Lab', { host: 'lab.example' }));
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: /^Lab/ }));
    await userEvent.type(screen.getByLabelText('Client ID'), '-2');

    expect(tag()).toHaveTextContent('Edited');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({
      name: 'Lab',
      connection: expect.objectContaining({ host: 'lab.example', clientId: 'mqttforge-console-2' }),
    });
    expect(screen.queryByLabelText('Save as')).not.toBeInTheDocument();
  });

  // A changed list of filters is a change like any other.
  it('counts a filter added as a change', async () => {
    withProfiles(profile('Lab', { host: 'lab.example' }));
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: /^Lab/ }));
    await userEvent.type(screen.getByLabelText('Add a topic filter'), 'plant/+/temp{enter}');

    expect(tag()).toHaveTextContent('Edited');
  });

  // The API never sends a password back, and a profile is saved as exactly what the form holds —
  // so saving a form filled from a card over that card would write it back without the password
  // it was kept with. The one-press save waits for the box to be filled in again.
  it('will not save over a broker whose password it cannot send back', async () => {
    const sent = savesTo();
    withProfiles(profile('Lab', { host: 'lab.example', username: 'alice', hasPassword: true }));
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: /^Lab/ }));
    await userEvent.type(screen.getByLabelText('Client ID'), '-2');

    const save = screen.getByRole('button', { name: 'Save changes' });
    expect(save).toBeDisabled();
    expect(save).toHaveAttribute('title', expect.stringMatching(/password/));

    await userEvent.type(screen.getByLabelText('Password'), 'hunter2');
    expect(save).toBeEnabled();

    await userEvent.click(save);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].connection).toMatchObject({ username: 'alice', password: 'hunter2' });
  });

  // The way out of a card somebody pressed to look at.
  it('starts a blank form from New, with the cursor in the address', async () => {
    withProfiles(profile('Lab', { host: 'lab.example', username: 'alice' }));
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: /^Lab/ }));
    expect(screen.getByLabelText('Username')).toHaveValue('alice');

    await userEvent.click(screen.getByRole('button', { name: 'New' }));

    expect(subject()).toHaveTextContent('New connection');
    expect(screen.getByLabelText('Address')).toHaveValue('localhost');
    expect(screen.getByLabelText('Address')).toHaveFocus();
    // Nothing of the card comes along to whatever is typed next.
    expect(screen.getByLabelText('Username')).toHaveValue('');
  });
});

/**
 * The brokers' column: a list to pick from and — once, while it is empty — to be told about.
 */
describe('the brokers this console knows', () => {
  const withProfiles = (...profiles: unknown[]) =>
    server.use(http.get('/api/connection/profiles', () => HttpResponse.json(profiles)));

  const lab = { name: 'Lab', connection: savedConnection({ host: 'lab.example' }) };

  // The one state in which the panel explains itself: nothing kept and nothing reached.
  it('says what the list is for while there is nothing in it', async () => {
    renderPanel();

    expect(await screen.findByText('No brokers yet')).toBeInTheDocument();
    const brokers = within(screen.getByRole('complementary', { name: 'Brokers' }));
    expect(brokers.getAllByRole('listitem')).toHaveLength(3);
    // And nothing to start over from.
    expect(screen.queryByRole('button', { name: 'New' })).not.toBeInTheDocument();
  });

  it('stops saying it the moment there is a broker to list', async () => {
    withProfiles(lab);
    renderPanel();

    await screen.findByRole('button', { name: /^Lab/ });
    expect(screen.queryByText('No brokers yet')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New' })).toBeInTheDocument();
  });

  // Inside a container 'localhost' is the container. Said before the attempt to a reader with no
  // broker yet, and with the fix as something to press.
  it('offers the host a container should dial, before the first attempt fails', async () => {
    server.use(
      http.get('/api/connection/defaults', () =>
        HttpResponse.json({ clientId: 'mqttforge-console', inContainer: true }),
      ),
    );
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'Use host.docker.internal' }));

    expect(screen.getByLabelText('Address')).toHaveValue('host.docker.internal');
    expect(screen.queryByRole('button', { name: 'Use host.docker.internal' })).not.toBeInTheDocument();
  });
});

/**
 * Whose word is taken for the broker's certificate: three answers, and exactly one is true of a
 * connection. They were a tick box and a path that could both be filled in at once.
 */
describe('whose word is taken for the broker’s certificate', () => {
  const system = () => screen.getByLabelText('Trust the system’s certificate authorities');
  const own = () => screen.getByLabelText('Also trust my own CA');
  const any = () => screen.getByLabelText('Accept any certificate');

  const open = async () => {
    renderPanel();
    await userEvent.selectOptions(await screen.findByLabelText('Protocol'), 'mqtts');
    await userEvent.click(screen.getByRole('button', { name: 'Security' }));
  };

  const watchConnect = () => {
    const seen: { tls?: Record<string, unknown> | null } = {};
    server.use(
      http.post('/api/connection', async ({ request }) => {
        seen.tls = ((await request.json()) as { tls: Record<string, unknown> | null }).tls;
        return HttpResponse.json({ state: 'Connected' });
      }),
      http.post('/api/subscriptions', () => new HttpResponse(null, { status: 202 })),
    );

    return seen;
  };

  it('starts on the system’s authorities, and asks for no path', async () => {
    await open();

    expect(system()).toBeChecked();
    expect(screen.queryByLabelText('Extra CA certificate')).not.toBeInTheDocument();
  });

  it('asks for the path under the one answer that needs one', async () => {
    await open();
    await userEvent.click(own());

    expect(own()).toBeChecked();
    expect(screen.getByLabelText('Extra CA certificate')).toBeVisible();
  });

  // The path is the longest thing typed on the panel. Looking at another answer does not cost it.
  it('keeps the path while another answer is looked at', async () => {
    const seen = watchConnect();
    await open();
    await userEvent.click(own());
    await userEvent.type(screen.getByLabelText('Extra CA certificate'), '/etc/mqtt/lab-ca.crt');

    await userEvent.click(system());
    expect(screen.queryByLabelText('Extra CA certificate')).not.toBeInTheDocument();

    await userEvent.click(own());
    expect(screen.getByLabelText('Extra CA certificate')).toHaveValue('/etc/mqtt/lab-ca.crt');

    // And the first answer means it: nothing is sent while it is the one chosen.
    await userEvent.click(system());
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(seen.tls).toBeNull());
  });

  it('says what accepting anything gives up, on the line that does it', async () => {
    await open();

    expect(any()).toHaveAccessibleDescription('Not checked. For test brokers only.');
  });

  it('comes back on the middle answer for a saved broker that carries a CA', async () => {
    server.use(
      http.get('/api/connection/settings', () =>
        HttpResponse.json(
          savedConnection({
            port: 8883,
            useTls: true,
            tls: {
              allowUntrustedCertificates: false,
              certificateAuthorityPath: '/etc/mqtt/lab-ca.crt',
              clientCertificatePath: null,
              clientCertificateKeyPath: null,
              hasClientCertificatePassword: false,
              sniHost: null,
              alpnProtocol: null,
            },
          }),
        ),
      ),
    );
    renderPanel();

    await waitFor(() => expect(own()).toBeChecked());
    expect(screen.getByLabelText('Extra CA certificate')).toHaveValue('/etc/mqtt/lab-ca.crt');
  });
});
