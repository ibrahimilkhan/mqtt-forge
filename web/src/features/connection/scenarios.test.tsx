import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../test/server';
import { useLogStore } from '../../stores/logStore';
import { useTopicTreeStore } from '../../stores/topicTreeStore';
import { BrokerPanel } from './BrokerPanel';
import type { ConnectRequest } from '../../types/api';

/**
 * Connections, end to end through the panel.
 *
 * BrokerPanel.test.tsx is about controls: what a chip does, what a box shows. This is about
 * whole connections — a reader arriving with the string their broker's documentation gave them,
 * filling the form the way that broker needs, and pressing Connect. What the API receives is the
 * only thing that matters here, because it is the only thing the broker will see.
 *
 * Every scenario is a broker that exists. The addresses and the shapes are real ones.
 */

const newQueryClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

function renderPanel() {
  const queryClient = newQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(<BrokerPanel onClose={vi.fn()} open={vi.fn()} />, { wrapper });
}

/** The request the API was asked for, or nothing if Connect never reached it. */
function watchConnect() {
  const seen: { request?: ConnectRequest } = {};

  server.use(
    http.post('/api/connection', async ({ request }) => {
      seen.request = (await request.json()) as ConnectRequest;
      return HttpResponse.json({ state: 'Connected' });
    }),
    http.post('/api/subscriptions', () => new HttpResponse(null, { status: 202 })),
  );

  return seen;
}

const address = () => screen.getByLabelText('Address');
const port = () => screen.getByLabelText('Port');

/** What a reader does with the one string their broker's documentation gave them. */
async function paste(text: string) {
  await userEvent.clear(address());
  await userEvent.paste(text);
}

async function type(field: HTMLElement, text: string) {
  await userEvent.clear(field);
  await userEvent.type(field, text);
  fireEvent.blur(field);
}

const connect = async () =>
  userEvent.click(await screen.findByRole('button', { name: 'Connect' }));

/**
 * Opens the fold, with the box above it on.
 *
 * The fold's fields follow that box — they are inert while encryption is off, which is the one
 * rule that block has — so filling any of them starts by saying the connection is encrypted.
 * Which is what a reader with a certificate is doing anyway: every broker whose documentation
 * hands you one hands you `mqtts://` in the same paragraph.
 */
const openEncryption = async () => {
  const box = screen.getByLabelText('Encrypted (TLS)') as HTMLInputElement;
  if (!box.checked) await userEvent.click(box);
  await userEvent.click(screen.getByText('Encryption'));
};

beforeEach(() => {
  useLogStore.getState().clear();
  useTopicTreeStore.getState().reset();
});

// ---- the brokers people actually connect to ----

describe('a broker of your own, on the machine this is running on', () => {
  it('connects to what the panel already holds, with nothing typed', async () => {
    const seen = watchConnect();
    renderPanel();

    await connect();

    await waitFor(() =>
      expect(seen.request).toMatchObject({
        host: 'localhost',
        port: 1883,
        useTls: false,
        transport: 'tcp',
        username: null,
        password: null,
        tls: null,
        webSocketPath: null,
      }),
    );
  });

  it('takes a hostname and a port typed by hand', async () => {
    const seen = watchConnect();
    renderPanel();

    await type(address(), '192.168.1.50');
    await type(port(), '11883');
    await connect();

    await waitFor(() => expect(seen.request).toMatchObject({ host: '192.168.1.50', port: 11883 }));
  });

  // The one address form that is nothing but colons.
  it('takes an IPv6 literal without losing the port', async () => {
    const seen = watchConnect();
    renderPanel();

    await paste('mqtt://[::1]:1883');
    await connect();

    await waitFor(() => expect(seen.request).toMatchObject({ host: '::1', port: 1883 }));
  });
});

describe('a broker with a password on it', () => {
  it('sends both, and neither when they are left empty', async () => {
    const seen = watchConnect();
    renderPanel();

    await userEvent.type(screen.getByLabelText('Username'), 'alice');
    await userEvent.type(screen.getByLabelText('Password'), 'hunter2');
    await connect();

    await waitFor(() =>
      expect(seen.request).toMatchObject({ username: 'alice', password: 'hunter2' }),
    );
  });

  // Null rather than "": a broker told to authenticate as nobody is a broker refusing the
  // connection, where one told nothing at all lets it through.
  it('sends nothing rather than nothing-in-particular', async () => {
    const seen = watchConnect();
    renderPanel();

    await connect();

    await waitFor(() => expect(seen.request).toMatchObject({ username: null, password: null }));
  });
});

describe('a cloud broker, from the string its console gave you', () => {
  // HiveMQ Cloud hands you exactly this.
  it('connects from a pasted mqtts:// address', async () => {
    const seen = watchConnect();
    renderPanel();

    await paste('mqtts://abc123.s1.eu.hivemq.cloud:8883');
    await userEvent.type(screen.getByLabelText('Username'), 'alice');
    await userEvent.type(screen.getByLabelText('Password'), 'hunter2');
    await connect();

    await waitFor(() =>
      expect(seen.request).toMatchObject({
        host: 'abc123.s1.eu.hivemq.cloud',
        port: 8883,
        useTls: true,
        transport: 'tcp',
        // Nothing under Encryption was touched: a publicly trusted certificate needs none of it.
        tls: null,
      }),
    );
  });

  // EMQX publishes its WebSocket endpoint with the path on the end.
  it('connects from a pasted wss:// address, path and all', async () => {
    const seen = watchConnect();
    renderPanel();

    await paste('wss://broker.emqx.io:8084/mqtt');
    await connect();

    await waitFor(() =>
      expect(seen.request).toMatchObject({
        host: 'broker.emqx.io',
        port: 8084,
        useTls: true,
        transport: 'webSocket',
        webSocketPath: '/mqtt',
      }),
    );
  });

  // What a browser's address bar gives you when you copy a WebSocket endpoint out of it.
  it('reads an https:// endpoint as the encrypted WebSocket it is', async () => {
    const seen = watchConnect();
    renderPanel();

    await paste('https://broker.example:443/mqtt');
    await connect();

    await waitFor(() =>
      expect(seen.request).toMatchObject({ transport: 'webSocket', useTls: true, port: 443 }),
    );
  });

  // The Paho and Eclipse documentation writes these.
  it.each([
    ['tcp://broker.example:1883', { transport: 'tcp', useTls: false }],
    ['ssl://broker.example:8883', { transport: 'tcp', useTls: true }],
    ['mqtt+ssl://broker.example:8883', { transport: 'tcp', useTls: true }],
  ])('reads %s the way its own documentation means it', async (pasted, expected) => {
    const seen = watchConnect();
    renderPanel();

    await paste(pasted);
    await connect();

    await waitFor(() => expect(seen.request).toMatchObject(expected));
  });
});

describe('a broker that knows you by certificate', () => {
  it('sends the certificate, its key and its password', async () => {
    const seen = watchConnect();
    renderPanel();

    await paste('mqtts://abc-ats.iot.eu-west-1.amazonaws.com:8883');
    await openEncryption();
    await userEvent.type(screen.getByLabelText('Client certificate'), '/etc/mqtt/client.pem.crt');
    await userEvent.type(screen.getByLabelText('Private key'), '/etc/mqtt/client.pem.key');
    await userEvent.type(screen.getByLabelText('Extra CA certificate'), '/etc/mqtt/AmazonRootCA1.pem');
    await connect();

    await waitFor(() =>
      expect(seen.request!.tls).toMatchObject({
        clientCertificatePath: '/etc/mqtt/client.pem.crt',
        clientCertificateKeyPath: '/etc/mqtt/client.pem.key',
        certificateAuthorityPath: '/etc/mqtt/AmazonRootCA1.pem',
      }),
    );
  });

  // AWS IoT Core on 443, which is the way through a firewall that allows only HTTPS.
  it('sends an ALPN protocol where one is needed', async () => {
    const seen = watchConnect();
    renderPanel();

    await paste('mqtts://abc-ats.iot.eu-west-1.amazonaws.com:443');
    await openEncryption();
    await userEvent.click(screen.getByText('Server name and ALPN'));
    await userEvent.type(screen.getByLabelText('ALPN protocol'), 'x-amzn-mqtt-ca');
    await connect();

    await waitFor(() =>
      expect(seen.request).toMatchObject({
        port: 443,
        useTls: true,
        tls: expect.objectContaining({ alpnProtocol: 'x-amzn-mqtt-ca' }),
      }),
    );
  });

  // Encryption is asked for before a certificate is, not by it. The fold's fields are inert while
  // the box above them is off — which is the rule — so ticking it is the first move, and the port
  // follows the tick without anyone typing one.
  it('asks for encryption before it asks for a certificate', async () => {
    const seen = watchConnect();
    renderPanel();

    await type(address(), 'broker.example');
    await userEvent.click(screen.getByText('Encryption'));

    // Nothing in the fold can be filled in yet.
    expect(screen.getByLabelText('Client certificate')).toBeDisabled();

    await userEvent.click(screen.getByLabelText('Encrypted (TLS)'));
    await userEvent.type(screen.getByLabelText('Client certificate'), '/etc/client.pfx');
    await connect();

    await waitFor(() => expect(seen.request).toMatchObject({ useTls: true, port: 8883 }));
  });
});

describe('a broker with a certificate it signed itself', () => {
  it('sends the CA that signed it, with verification left on', async () => {
    const seen = watchConnect();
    renderPanel();

    await type(port(), '8883');
    await openEncryption();
    await userEvent.type(screen.getByLabelText('Extra CA certificate'), '/etc/mqtt/lab-ca.crt');
    await connect();

    await waitFor(() =>
      expect(seen.request!.tls).toMatchObject({
        certificateAuthorityPath: '/etc/mqtt/lab-ca.crt',
        allowUntrustedCertificates: false,
      }),
    );
  });

  it('turns verification off when the box is ticked instead', async () => {
    const seen = watchConnect();
    renderPanel();

    await openEncryption();
    await userEvent.click(screen.getByLabelText('Accept any certificate'));
    await connect();

    await waitFor(() =>
      expect(seen.request).toMatchObject({
        useTls: true,
        tls: expect.objectContaining({ allowUntrustedCertificates: true }),
      }),
    );
  });
});

// ---- the fields that answer to other fields ----

describe('what one answer does to the next', () => {
  it('moves the port when the way in changes, and leaves a typed one alone', async () => {
    renderPanel();

    await userEvent.click(screen.getByLabelText('Encrypted (TLS)'));
    expect(port()).toHaveValue(8883);

    await userEvent.selectOptions(screen.getByLabelText('Transport'), 'webSocket');
    expect(port()).toHaveValue(8084);

    await type(port(), '9001');
    await userEvent.click(screen.getByLabelText('Encrypted (TLS)'));
    expect(port()).toHaveValue(9001);
  });

  it('drops a WebSocket path on the way out of a TCP connection', async () => {
    const seen = watchConnect();
    renderPanel();

    await userEvent.selectOptions(screen.getByLabelText('Transport'), 'webSocket');
    await userEvent.type(screen.getByLabelText('WebSocket path'), '/ws');
    await userEvent.selectOptions(screen.getByLabelText('Transport'), 'tcp');
    await connect();

    await waitFor(() => expect(seen.request).toMatchObject({ webSocketPath: null }));
  });

  // The panel stops showing the key beside a bundle; what was typed before must not travel.
  it('drops a private key once the certificate carries its own', async () => {
    const seen = watchConnect();
    renderPanel();

    await openEncryption();
    await userEvent.type(screen.getByLabelText('Client certificate'), '/etc/client.crt');
    await userEvent.type(screen.getByLabelText('Private key'), '/etc/client.key');
    await type(screen.getByLabelText('Client certificate'), '/etc/client.pfx');
    await connect();

    await waitFor(() =>
      expect(seen.request!.tls).toMatchObject({
        clientCertificatePath: '/etc/client.pfx',
        clientCertificateKeyPath: null,
      }),
    );
  });

  it('asks for a session expiry only where a session is being kept', async () => {
    const seen = watchConnect();
    renderPanel();

    expect(screen.queryByLabelText('Session expiry')).not.toBeInTheDocument();

    await userEvent.click(screen.getByLabelText('Clean session'));
    await userEvent.type(screen.getByLabelText('Session expiry'), '600');
    await connect();

    await waitFor(() =>
      expect(seen.request).toMatchObject({ cleanSession: false, sessionExpiryInterval: 600 }),
    );
  });

  it('sends no expiry when the session is thrown away at the end', async () => {
    const seen = watchConnect();
    renderPanel();

    await connect();

    await waitFor(() =>
      expect(seen.request).toMatchObject({ cleanSession: true, sessionExpiryInterval: null }),
    );
  });
});

// ---- what happens when it does not work ----

describe('a connection that does not come up', () => {
  const refuses = (reason: string) =>
    server.use(
      http.post('/api/connection', () =>
        HttpResponse.json(
          { title: 'Could not connect to broker', detail: 'raw backend detail', reason },
          { status: 502 },
        ),
      ),
    );

  it.each([
    ['refused', 'Nothing is listening at localhost:1883.'],
    ['hostNotFound', 'No host named localhost.'],
    ['timeout', "localhost:1883 didn't respond in time."],
    ['credentialsRejected', 'The broker rejected the username or password.'],
    ['banned', 'The broker has banned this client.'],
  ])('says what happened for %s', async (reason, said) => {
    refuses(reason);
    renderPanel();

    await connect();

    expect(await screen.findByText(said)).toBeInTheDocument();
  });

  // The one path with no backend detail to fall back on used to show nothing at all.
  it('names the broker even when nothing could name the reason', async () => {
    server.use(
      http.get('/api/connection', () =>
        HttpResponse.json({
          state: 'Faulted',
          failure: {
            reason: 'unknown',
            host: 'broker.example',
            port: 1883,
            clientId: 'console',
            useTls: false,
            transport: 'tcp',
            protocolVersion: 'auto',
          },
        }),
      ),
    );
    renderPanel();

    expect(
      await screen.findByText('The connection to broker.example:1883 failed, and nothing said why.'),
    ).toBeInTheDocument();
  });

  // A field the API refuses prints under the box it is about, not as a sentence at the foot.
  it('puts a refused field under the field', async () => {
    server.use(
      http.post('/api/connection', () =>
        HttpResponse.json(
          {
            title: 'One or more validation errors occurred.',
            errors: { Host: ['Host is required'] },
          },
          { status: 400 },
        ),
      ),
    );
    renderPanel();

    await type(address(), '   ');
    await connect();

    expect(await screen.findByText('Host is required')).toBeInTheDocument();
  });
});

// The two things a pair of hands does without being told to.
describe('the keyboard, which is what most of this is filled in with', () => {
  it('connects on Enter from the address box', async () => {
    const seen = watchConnect();
    renderPanel();

    await userEvent.clear(address());
    await userEvent.type(address(), 'broker.example{Enter}');

    await waitFor(() => expect(seen.request).toMatchObject({ host: 'broker.example' }));
  });

  it.each(['Port', 'Username', 'Password', 'Client ID'])('connects on Enter from %s', async (label) => {
    const seen = watchConnect();
    renderPanel();

    await userEvent.type(screen.getByLabelText(label), '{Enter}');

    await waitFor(() => expect(seen.request).toBeDefined());
  });

  // The name box answers Enter itself, and a keystroke that reached the form from inside it
  // would connect as well as save.
  it('saves rather than connects on Enter in the name box', async () => {
    const seen = watchConnect();
    let saved: unknown;
    server.use(
      http.put('/api/connection/profiles', async ({ request }) => {
        saved = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'Save' }));
    await userEvent.type(screen.getByLabelText('Save as'), '{Enter}');

    await waitFor(() => expect(saved).toMatchObject({ name: 'localhost:1883' }));
    expect(seen.request).toBeUndefined();
  });

  it('does nothing on Enter over a live link, which Connect cannot do anyway', async () => {
    const seen = watchConnect();
    server.use(http.get('/api/connection', () => HttpResponse.json({ state: 'Connected' })));
    renderPanel();

    await screen.findByRole('button', { name: 'Disconnect' });
    await userEvent.type(screen.getByLabelText('Port'), '{Enter}');

    expect(seen.request).toBeUndefined();
  });

  // Where a reader who opened this panel is going to type first.
  it('puts the cursor in the address box on the way in', async () => {
    renderPanel();

    await waitFor(() => expect(address()).toHaveFocus());
  });

  // That panel was opened to read the summary or to end the connection.
  it('leaves the cursor alone over a live link', async () => {
    server.use(http.get('/api/connection', () => HttpResponse.json({ state: 'Connected' })));
    renderPanel();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Disconnect' })).toBeEnabled());
    expect(address()).not.toHaveFocus();
  });
});
