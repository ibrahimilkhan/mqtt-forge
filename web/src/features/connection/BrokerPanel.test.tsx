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
import { BROKER_PRESETS, CLOUD_PRESETS } from './presets';
import { isEncrypted } from './scheme';

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
      expect(screen.getByLabelText('Broker address')).toHaveValue('broker.example'),
    );
    expect(screen.getByLabelText('Port')).toHaveValue(8883);
    expect(screen.getByLabelText('Client ID')).toHaveValue('saved-client');
    expect(screen.getByLabelText('Username')).toHaveValue('alice');
    // The way in comes back as the two controls it is asked in: this connection was over TLS.
    expect(screen.getByLabelText('Transport')).toHaveValue('tcp');
    expect(screen.getByLabelText('Encrypted (TLS)')).toBeChecked();
    expect(screen.getByRole('radio', { name: '3.1.1' })).toBeChecked();
  });

  it('says a password is stored but never returned', async () => {
    server.use(
      http.get('/api/connection/settings', () =>
        HttpResponse.json(savedConnection({ host: 'h', clientId: 'c', hasPassword: true })),
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

    expect(screen.getByLabelText('Broker address')).toHaveValue(hsl.host);
    expect(screen.getByLabelText('Port')).toHaveValue(hsl.port);
  });

  it('brings the scheme with the port, rather than leaving the two disagreeing', async () => {
    renderPanel();
    await pick(hsl.name);

    expect(screen.getByLabelText('Transport')).toHaveValue('tcp');
    expect(screen.getByLabelText('Encrypted (TLS)')).toBeChecked();
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
    await userEvent.clear(screen.getByLabelText('Broker address'));
    await userEvent.type(screen.getByLabelText('Broker address'), 'somewhere.else');

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
        HttpResponse.json(
          savedConnection({ host: hsl.host, port: hsl.port, useTls: isEncrypted(hsl.scheme) }),
        ),
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
        HttpResponse.json(savedConnection()),
      ),
    );

    renderPanel();

    await waitFor(() =>
      expect(screen.getByLabelText('Broker address')).toHaveValue('broker.example'),
    );
    expect(screen.getByLabelText('On-connect filter')).toHaveValue('#');
  });

  it('explains what the broker is once one is picked', async () => {
    renderPanel();
    await pick(hsl.name);

    expect(screen.getByText(hsl.note)).toBeInTheDocument();
  });
});

// ---- the version, as a thing the panel actually does ----

describe('picking which MQTT to speak', () => {
  const version = (name: string) => screen.getByRole('radio', { name });

  it('starts on Auto, because the reader is the wrong person to ask', () => {
    renderPanel();

    expect(version('Auto')).toBeChecked();
  });

  it('sends the version that was picked', async () => {
    let sent: Record<string, unknown> | undefined;
    server.use(
      http.post('/api/connection', async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ state: 'Connected' });
      }),
    );

    renderPanel();
    await userEvent.click(version('3.1.1'));
    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(sent).toMatchObject({ protocolVersion: 'v311' }));
  });

  // The same bit on the wire, and the two specifications call it different things. A reader
  // reading MQTT 5 documentation should find the word that documentation uses.
  it('calls the box what the chosen version calls it', async () => {
    renderPanel();
    expect(screen.getByLabelText('Clean session')).toBeInTheDocument();

    await userEvent.click(version('5.0'));
    expect(screen.getByLabelText('Clean start')).toBeInTheDocument();
  });

  // The version difference this form actually has to show. Unticking the box is what makes
  // session lifetime a question; only one of the two versions lets you answer it.
  it('offers an expiry for a kept session on 5.0, and explains its absence on 3.1.1', async () => {
    renderPanel();
    expect(screen.queryByLabelText('Session expiry')).not.toBeInTheDocument();

    await userEvent.click(screen.getByLabelText('Clean session'));
    expect(screen.getByLabelText('Session expiry')).toBeInTheDocument();

    await userEvent.click(version('3.1.1'));
    expect(screen.queryByLabelText('Session expiry')).not.toBeInTheDocument();
    expect(
      screen.getByText(/On MQTT 3.1.1 a kept session has no expiry to set/),
    ).toBeInTheDocument();
  });

  // The specification's own limit, said before the broker says it — a 3.1 broker's refusal
  // names neither the length nor the version.
  it('warns about a client ID too long for 3.1, and only for 3.1', async () => {
    renderPanel();
    const clientId = screen.getByLabelText('Client ID');
    await userEvent.clear(clientId);
    await userEvent.type(clientId, 'a-client-id-of-more-than-twenty-three');

    expect(screen.queryByText(/MQTT 3.1 allows/)).not.toBeInTheDocument();

    await userEvent.click(version('3.1'));
    expect(screen.getByText(/MQTT 3.1 allows 23 characters; this is 37/)).toBeInTheDocument();
  });
});

describe('a cloud service, whose address is yours', () => {
  const aws = CLOUD_PRESETS.find((p) => p.name === 'AWS IoT Core')!;

  // Three of these sit on 8883 over mqtts, so a preset with no host matched all three and lit
  // whichever came first — press AWS IoT Core and HiveMQ Cloud's chip came on, with HiveMQ
  // Cloud's instructions under it.
  it('lights its own chip and nobody else\'s', async () => {
    renderPanel();
    await userEvent.click(screen.getByRole('button', { name: aws.name }));

    expect(screen.getByRole('button', { name: aws.name })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'HiveMQ Cloud' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByText(aws.note)).toBeInTheDocument();
    expect(screen.queryByText(CLOUD_PRESETS[0].note)).not.toBeInTheDocument();
  });

  it('fills in the shape and leaves the address blank', async () => {
    renderPanel();
    await userEvent.click(screen.getByRole('button', { name: aws.name }));

    expect(screen.getByLabelText('Broker address')).toHaveValue('');
    expect(screen.getByLabelText('Port')).toHaveValue(aws.port);
    expect(screen.getByLabelText('Encrypted (TLS)')).toBeChecked();
  });

  // The note is the whole point of a cloud preset — it is the only place the port, the paths
  // and the shape of the credentials are written down together — and it has to survive the
  // reader typing the address it deliberately left empty.
  it('keeps its instructions on screen while the address is being pasted in', async () => {
    renderPanel();
    await userEvent.click(screen.getByRole('button', { name: aws.name }));
    await userEvent.type(
      screen.getByLabelText('Broker address'),
      'abc-ats.iot.eu-west-1.amazonaws.com',
    );

    expect(screen.getByText(aws.note)).toBeInTheDocument();
  });
});

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

  it('is the form itself while nothing is connected', async () => {
    renderPanel();

    await screen.findByRole('button', { name: 'Connect' });
    expect(fold('Connect somewhere else').open).toBe(true);
  });

  it('keeps the client, the session and the known brokers behind their own lines', async () => {
    renderPanel();

    await screen.findByRole('button', { name: 'Connect' });
    expect(fold('Client and session').open).toBe(false);
    expect(fold('Start from a known broker').open).toBe(false);
  });

  // Reopened over a working link, the question is what is up — not where to connect, which this
  // reader has already answered.
  it('leads with the live link and folds the form behind it', async () => {
    connected();
    renderPanel();

    const details = await screen.findByLabelText('Connection details');
    expect(fold('Connect somewhere else').open).toBe(false);
    // The link stands above the fold that holds the form, not under it.
    expect(details.compareDocumentPosition(fold('Connect somewhere else'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('opens the form again on request, without losing the link', async () => {
    connected();
    renderPanel();

    await screen.findByLabelText('Connection details');
    await userEvent.click(screen.getByText('Connect somewhere else'));

    expect(fold('Connect somewhere else').open).toBe(true);
    expect(screen.getByLabelText('Connection details')).toBeInTheDocument();
  });

  // The fold offers to connect somewhere else and the button under it will not, a live link
  // being the one thing this panel cannot connect over. Said, rather than left to be inferred
  // from a greyed button.
  it('says why Connect will not fire while a link is up', async () => {
    connected();
    renderPanel();

    await screen.findByLabelText('Connection details');
    await userEvent.click(screen.getByText('Connect somewhere else'));

    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
    expect(screen.getByText('Disconnect first — one link at a time.')).toBeInTheDocument();
  });
});

// Every broker's own documentation hands you one string. Taking it apart into a scheme, a host,
// a port and a path is the first thing anyone does here and the easiest to get wrong, so the
// box does it. The splitting itself is covered in address.test.ts; this is the wiring.
describe('an address dropped into the Broker address box', () => {
  it('fills the scheme, the port and the path from a pasted URL', async () => {
    renderPanel();

    const address = await screen.findByLabelText('Broker address');
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

    const address = await screen.findByLabelText('Broker address');
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

    const address = await screen.findByLabelText('Broker address');
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
  const address = () => screen.getByLabelText('Broker address');

  it('says what the scheme is in a sentence, with nothing to press', () => {
    renderPanel();

    expect(
      screen.getByText('Plain MQTT over TCP. Nothing on the wire is encrypted.'),
    ).toBeInTheDocument();
  });

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
    const address = screen.getByLabelText('Broker address');
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

  it('says what the two answers add up to, in a sentence', async () => {
    renderPanel();
    expect(
      screen.getByText('Plain MQTT over TCP. Nothing on the wire is encrypted.'),
    ).toBeInTheDocument();

    await userEvent.click(encrypted());
    expect(
      screen.getByText('MQTT over TLS, straight to the broker. What every cloud broker wants.'),
    ).toBeInTheDocument();
  });

  // A pasted address still answers both, which is the point of taking it whole.
  it('reads both answers off a pasted address', async () => {
    renderPanel();
    const address = screen.getByLabelText('Broker address');
    await userEvent.clear(address);
    await userEvent.paste('wss://broker.emqx.io:8084/mqtt');

    expect(transport()).toHaveValue('webSocket');
    expect(encrypted()).toBeChecked();
    expect(address).toHaveValue('broker.emqx.io');
  });
});

// The rule the reader asked for, in the direction it is true. A certificate is a statement that
// this connection is encrypted; the absence of one says nothing, since nine of the ten encrypted
// brokers this console ships a preset for need no certificate at all.
describe('a certificate, which settles the question by itself', () => {
  const encrypted = () => screen.getByLabelText('Encrypted (TLS)');

  it('offers the encryption fields whether or not encryption is on yet', () => {
    renderPanel();

    expect(screen.getByText('Encryption')).toBeInTheDocument();
  });

  it('turns encryption on when a certificate is named', async () => {
    renderPanel();
    await userEvent.type(screen.getByLabelText('Client certificate'), '/tmp/client.pem');

    await waitFor(() => expect(encrypted()).toBeChecked());
  });

  it('turns it on for a CA, and for accepting any certificate', async () => {
    renderPanel();
    await userEvent.type(screen.getByLabelText('Extra CA certificate'), '/tmp/ca.crt');
    expect(encrypted()).toBeChecked();

    renderPanel();
    await userEvent.click(screen.getAllByLabelText('Accept any certificate')[1]);
    expect(screen.getAllByLabelText('Encrypted (TLS)')[1]).toBeChecked();
  });

  it('holds it on while the certificate is there, and says why', async () => {
    renderPanel();
    await userEvent.type(screen.getByLabelText('Client certificate'), '/tmp/client.pem');

    expect(encrypted()).toBeDisabled();
    expect(
      screen.getByText(
        'Held on by what is under Encryption: a certificate means nothing to a connection that is not encrypted.',
      ),
    ).toBeInTheDocument();
  });

  it('lets go once the certificate does', async () => {
    renderPanel();
    const cert = screen.getByLabelText('Client certificate');
    await userEvent.type(cert, '/tmp/client.pem');
    await userEvent.clear(cert);

    expect(encrypted()).toBeEnabled();
    // Still on: turning encryption off by itself would be a surprise, and the reader can.
    expect(encrypted()).toBeChecked();
  });

  it('sends the certificate it was turned on by', async () => {
    let sent: Record<string, unknown> | undefined;
    server.use(
      http.post('/api/connection', async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ state: 'Connected' });
      }),
    );

    renderPanel();
    await userEvent.type(screen.getByLabelText('Client certificate'), '/tmp/client.pem');
    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));

    await waitFor(() =>
      expect(sent).toMatchObject({
        useTls: true,
        tls: expect.objectContaining({ clientCertificatePath: '/tmp/client.pem' }),
      }),
    );
  });
});
