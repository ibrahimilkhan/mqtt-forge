import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useLogStore } from '../../stores/logStore';
import { useTopicTreeStore } from '../../stores/topicTreeStore';
import { queryKeys } from '../../api/queryKeys';
import { server } from '../../test/server';
import { BrokerPanel, SETTLE } from './BrokerPanel';

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
  const open = vi.fn();
  return { ...render(<BrokerPanel onClose={onClose} open={open} />, { wrapper }), onClose, open };
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
    // The way in comes back as the two controls it is asked in: this connection was over TLS.
    expect(screen.getByLabelText('Transport')).toHaveValue('tcp');
    expect(screen.getByLabelText('Encrypted (TLS)')).toBeChecked();
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
    // And the way out of this particular dead end is still under it.
    expect(screen.getByRole('button', { name: 'Ask for less in Filters' })).toBeInTheDocument();
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

const fold = (name: string) => screen.getByText(name).closest('details') as HTMLDetailsElement;

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
  it('keeps the certificates behind a line, and nothing else', async () => {
    renderPanel();

    await screen.findByRole('button', { name: 'Connect' });
    expect(fold('Encryption').open).toBe(false);
    expect(screen.getByLabelText('Client ID')).toBeVisible();
    expect(screen.queryByText('Client and session')).not.toBeInTheDocument();
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

  // Reopened over a working link, the question is what is up — not where to connect, which this
  // reader has already answered.
  it('leads with the live link when there is one', async () => {
    connected();
    renderPanel();

    const details = await screen.findByLabelText('Connection details');
    const address = screen.getByLabelText('Address');

    expect(details.compareDocumentPosition(address)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
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
    expect(screen.getByLabelText('Transport')).toHaveValue('webSocket');
    expect(screen.getByLabelText('Encrypted (TLS)')).toBeChecked();
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
    expect(screen.getByLabelText('Encrypted (TLS)')).toBeChecked();
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
    expect(screen.getByLabelText('Encrypted (TLS)')).not.toBeChecked();
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
  const encrypted = () => screen.getByLabelText('Encrypted (TLS)');
  const port = () => screen.getByLabelText('Port');

  const typePort = async (value: string) => {
    await userEvent.clear(port());
    await userEvent.type(port(), value);
    fireEvent.blur(port());
  };

  it('turns encryption on for the encrypted port', async () => {
    renderPanel();
    await typePort('8883');

    await waitFor(() => expect(encrypted()).toBeChecked());
  });

  it('turns it off again for the plain port', async () => {
    renderPanel();
    await userEvent.click(encrypted());
    await typePort('1883');

    await waitFor(() => expect(encrypted()).not.toBeChecked());
  });

  // 8883 typed a digit at a time passes through 8, 88 and 888. A scheme moving on each of them
  // would land wherever the last keystroke left it, which is why this waits for the box to be
  // left rather than reading the keystroke.
  it('waits for the box to be left rather than moving mid-number', async () => {
    renderPanel();
    await userEvent.clear(port());
    await userEvent.type(port(), '8883');

    expect(encrypted()).not.toBeChecked();

    fireEvent.blur(port());
    await waitFor(() => expect(encrypted()).toBeChecked());
  });

  it('leaves a lab broker on a strange port where it was put', async () => {
    renderPanel();
    await typePort('21883');

    expect(encrypted()).not.toBeChecked();
  });

  // Somebody over a WebSocket picked it deliberately, and 8883 over wss is a real broker. The
  // port may tick the box; it may never move the control above it.
  it('never crosses the transport', async () => {
    renderPanel();
    await userEvent.selectOptions(screen.getByLabelText('Transport'), 'webSocket');
    await userEvent.click(encrypted());
    await typePort('8883');

    expect(screen.getByLabelText('Transport')).toHaveValue('webSocket');
    expect(encrypted()).toBeChecked();
  });
});

// The advice connectFailure.ts has written in prose since it was built, as a button. This is
// where a reader who did not know which of the four to pick actually finds out.
describe('a failure that names the scheme it should have been', () => {
  const failWith = (reason: string) =>
    server.use(
      http.post('/api/connection', () =>
        HttpResponse.json(
          { title: 'Could not connect to broker', detail: 'raw backend detail', reason },
          { status: 502 },
        ),
      ),
    );

  const connect = async () =>
    userEvent.click(await screen.findByRole('button', { name: 'Connect' }));

  // The one route left to plain MQTT on the encrypted port, and the one people take: an address
  // that names both. Typing 8883 into the Port box moves the scheme, and pressing mqtt back
  // afterwards drags the port to 1883 with it — the panel resists this state everywhere except
  // where the reader writes it down themselves.
  const writeAddress = async (text: string) => {
    const address = screen.getByLabelText('Address');
    await userEvent.clear(address);
    await userEvent.type(address, text);
    fireEvent.blur(address);
  };

  it('offers the encrypted scheme when the encrypted port said nothing', async () => {
    failWith('timeout');
    renderPanel();

    await writeAddress('mqtt://broker.example:8883');
    await connect();

    expect(await screen.findByRole('button', { name: 'Try mqtts:// instead' })).toBeInTheDocument();
  });

  it('retries on the scheme it offered', async () => {
    let sent: Record<string, unknown> | undefined;
    server.use(
      http.post('/api/connection', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        if (body.useTls) {
          sent = body;
          return HttpResponse.json({ state: 'Connected' });
        }
        return HttpResponse.json(
          { title: 'Could not connect to broker', detail: 'raw', reason: 'timeout' },
          { status: 502 },
        );
      }),
    );
    renderPanel();

    await writeAddress('mqtt://broker.example:8883');
    await connect();

    await userEvent.click(await screen.findByRole('button', { name: 'Try mqtts:// instead' }));

    await waitFor(() => expect(sent).toMatchObject({ useTls: true, port: 8883 }));
  });

  it('offers the plain scheme when the broker refuses encryption', async () => {
    failWith('tlsNotOffered');
    renderPanel();
    await userEvent.click(screen.getByLabelText('Encrypted (TLS)'));
    await connect();

    expect(await screen.findByRole('button', { name: 'Try mqtt:// instead' })).toBeInTheDocument();
  });

  // A rejected password is about the password. An offer standing where the real answer should
  // be is worse than no offer.
  it('offers nothing for a failure that is not about the scheme', async () => {
    failWith('credentialsRejected');
    renderPanel();
    await connect();

    expect(
      await screen.findByText('The broker rejected the username or password.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Try / })).not.toBeInTheDocument();
  });
});

// Four names were two questions multiplied together, asked as one. The API has always kept them
// apart — a transport and a TLS flag — and this is the panel finally asking them that way.
describe('the way in, as two questions', () => {
  const transport = () => screen.getByLabelText('Transport');
  const encrypted = () => screen.getByLabelText('Encrypted (TLS)');

  it('offers two ways in, not four', () => {
    renderPanel();

    expect([...transport().querySelectorAll('option')].map((o) => o.textContent)).toEqual([
      'mqtt://',
      'ws://',
    ]);
  });

  it('starts on plain MQTT, which is what a broker of your own usually is', () => {
    renderPanel();

    expect(transport()).toHaveValue('tcp');
    expect(encrypted()).not.toBeChecked();
    expect(screen.getByLabelText('Port')).toHaveValue(1883);
  });

  // The whole point: 'Encrypted' is a word everybody has, and the s in mqtts is the same
  // question asked in a letter nobody can see.
  it('sends the two answers as a transport and a TLS flag', async () => {
    let sent: Record<string, unknown> | undefined;
    server.use(
      http.post('/api/connection', async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ state: 'Connected' });
      }),
    );

    renderPanel();
    await userEvent.selectOptions(transport(), 'webSocket');
    await userEvent.click(encrypted());
    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(sent).toMatchObject({ transport: 'webSocket', useTls: true }));
  });

  it('moves the port with either answer, while the port is still a default', async () => {
    renderPanel();
    await userEvent.click(encrypted());
    expect(screen.getByLabelText('Port')).toHaveValue(8883);

    await userEvent.selectOptions(transport(), 'webSocket');
    expect(screen.getByLabelText('Port')).toHaveValue(8084);
  });

  it('leaves a port somebody typed exactly where they typed it', async () => {
    renderPanel();
    const port = screen.getByLabelText('Port');
    await userEvent.clear(port);
    await userEvent.type(port, '21883');
    await userEvent.click(encrypted());

    expect(port).toHaveValue(21883);
  });

  it('asks for a path only where there is a WebSocket to put it on', async () => {
    renderPanel();
    expect(screen.queryByLabelText('WebSocket path')).not.toBeInTheDocument();

    await userEvent.selectOptions(transport(), 'webSocket');
    expect(screen.getByLabelText('WebSocket path')).toBeInTheDocument();
  });

  // A pasted address still answers both, which is the point of taking it whole.
  it('reads both answers off a pasted address', async () => {
    renderPanel();
    const address = screen.getByLabelText('Address');
    await userEvent.clear(address);
    await userEvent.paste('wss://broker.emqx.io:8084/mqtt');

    expect(transport()).toHaveValue('webSocket');
    expect(encrypted()).toBeChecked();
    expect(address).toHaveValue('broker.emqx.io');
  });
});

// One rule for the whole of Encryption: its fields follow the box above them. Under a plain
// scheme the server is never shown any of this — buildConnectRequest sends tls: null and
// ConfigureTls is only reached when UseTls — so with encryption off these controls do nothing
// whatever they hold, and now they say so.
describe('the encryption fold, which follows the box above it', () => {
  const encrypted = () => screen.getByLabelText('Encrypted (TLS)');
  const encrypt = () => userEvent.click(encrypted());
  const openFold = () => userEvent.click(screen.getByText('Encryption'));

  it('offers the fold whether or not encryption is on yet', () => {
    renderPanel();

    expect(screen.getByText('Encryption')).toBeInTheDocument();
  });

  // Reading what a connection could be given is never blocked, only writing it. So the fold
  // opens, the fold inside it opens, and every field in both is held.
  it('opens with encryption off and holds every field in it', async () => {
    renderPanel();
    await openFold();

    expect(screen.getByLabelText('Accept any certificate')).toBeDisabled();
    expect(screen.getByLabelText('Extra CA certificate')).toBeDisabled();
    expect(screen.getByLabelText('Client certificate')).toBeDisabled();

    await userEvent.click(screen.getByText('Server name and ALPN'));
    expect(screen.getByLabelText('Server name')).toBeDisabled();
    expect(screen.getByLabelText('ALPN protocol')).toBeDisabled();
  });

  it('gives every field back when the box goes on', async () => {
    renderPanel();
    await openFold();
    await encrypt();

    expect(screen.getByLabelText('Accept any certificate')).toBeEnabled();
    expect(screen.getByLabelText('Extra CA certificate')).toBeEnabled();
    expect(screen.getByLabelText('Client certificate')).toBeEnabled();
  });

  // The box is the way back on, so it is outside the rule it governs. It was inside once, held
  // shut by the fields under it, and the dead end that made is what unlocked it.
  it('never holds the box itself', async () => {
    renderPanel();
    expect(encrypted()).toBeEnabled();

    await encrypt();
    expect(encrypted()).toBeEnabled();

    await encrypt();
    expect(encrypted()).toBeEnabled();
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
    await encrypt();
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

  // The buttons stand beside the fields, inside the fold, so they follow the box above it like
  // everything else in there.
  const encrypt = async () => userEvent.click(await screen.findByLabelText('Encrypted (TLS)'));

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
    expect(screen.getByLabelText('Encrypted (TLS)')).toBeChecked();
  });

  it('asks for the field the button stands beside', async () => {
    const asked = dialog(['/tmp/ca.crt']);
    renderPanel();
    await encrypt();

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

  it('asks for everything, and says so in one box', () => {
    renderPanel();

    expect(screen.getByLabelText('Listen to every topic on connect')).toBeChecked();
    expect(screen.queryByLabelText('On-connect filter')).not.toBeInTheDocument();
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

    await waitFor(() => expect(asked).toEqual({ topicFilter: '#', qos: 0 }));
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
    await userEvent.click(screen.getByLabelText('Listen to every topic on connect'));
    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled());
    expect(asked).toBe(false);
  });

  // The dead end, and the way out of it. Without this the reader is connected to nothing with
  // nothing on screen to do about it.
  it.each(['filterRefused', 'notPermitted'])('offers Filters after %s', async (reason) => {
    faulted(reason);
    const { open } = renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'Ask for less in Filters' }));

    expect(open).toHaveBeenCalledWith('subscribe');
  });

  it('offers nothing of the sort for a failure about the connection itself', async () => {
    faulted('credentialsRejected');
    renderPanel();

    expect(await screen.findByText('The broker rejected the username or password.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ask for less in Filters' })).not.toBeInTheDocument();
  });
});

// The section at the foot used to hold eleven brokers somebody else runs. These are the ones the
// reader kept, which is the whole difference: a list nobody wrote but them.
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
    expect(screen.queryByRole('group', { name: 'Saved brokers' })).not.toBeInTheDocument();
  });

  it('names each one, and offers to forget it', async () => {
    withProfiles(savedProfile('Lab broker'), savedProfile('Staging'));
    renderPanel();

    expect(await screen.findByRole('button', { name: 'Lab broker' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Forget Staging' })).toBeInTheDocument();
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
    await userEvent.click(screen.getByRole('button', { name: 'Save this broker' }));

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

    await userEvent.click(await screen.findByRole('button', { name: 'Save this broker' }));

    expect(screen.getByLabelText('Save as')).toHaveValue('localhost:1883');
  });

  it('gives up on Cancel without asking anything', async () => {
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'Save this broker' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByLabelText('Save as')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save this broker' })).toBeInTheDocument();
  });

  it('will not keep one under no name at all', async () => {
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'Save this broker' }));
    await userEvent.clear(screen.getByLabelText('Save as'));

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('fills the form from a chip', async () => {
    withProfiles(savedProfile('Lab broker', { host: 'lab.example', port: 8883, useTls: true }));
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'Lab broker' }));

    expect(screen.getByLabelText('Address')).toHaveValue('lab.example');
    expect(screen.getByLabelText('Port')).toHaveValue(8883);
    expect(screen.getByLabelText('Encrypted (TLS)')).toBeChecked();
  });

  // Derived, not remembered: type over the address and the chip goes out by itself.
  it('stops marking the chip once the form is no longer that broker', async () => {
    withProfiles(savedProfile('Lab broker', { host: 'lab.example' }));
    renderPanel();

    const chip = await screen.findByRole('button', { name: 'Lab broker' });
    await userEvent.click(chip);
    expect(chip.closest('span')).toHaveAttribute('data-active');

    const address = screen.getByLabelText('Address');
    await userEvent.clear(address);
    await userEvent.type(address, 'somewhere.else');
    fireEvent.blur(address);

    await waitFor(() => expect(chip.closest('span')).not.toHaveAttribute('data-active'));
  });

  it('forgets one when its cross is pressed', async () => {
    let deleted: string | undefined;
    withProfiles(savedProfile('Lab broker'));
    server.use(
      http.delete('/api/connection/profiles/:name', ({ params }) => {
        deleted = params.name as string;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'Forget Lab broker' }));

    await waitFor(() => expect(deleted).toBe('Lab broker'));
  });
});

// Seven fields, but not seven at once: a key and a password are for a certificate, and a
// certificate in a .pfx carries its own key.
describe('the encryption fields, as far as they apply', () => {
  // With the box on: the fold's fields follow it, and a field that cannot be typed into cannot
  // show what typing into it reveals.
  const openEncryption = async () => {
    renderPanel();
    await userEvent.click(await screen.findByLabelText('Encrypted (TLS)'));
    await userEvent.click(screen.getByText('Encryption'));
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
