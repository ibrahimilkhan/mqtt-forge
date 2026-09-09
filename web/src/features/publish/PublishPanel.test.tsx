import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useComposeStore } from '../../stores/composeStore';
import { useLogStore } from '../../stores/logStore';
import { server } from '../../test/server';
import { PublishPanel } from './PublishPanel';

/** A live link, and which MQTT it settled on — the fold below is offered on one of them only. */
function renderPanel(speaking?: 'v500' | 'v311') {
  // Publish button is disabled without a live broker.
  server.use(
    http.get('/api/connection', () =>
      HttpResponse.json({
        state: 'Connected',
        ...(speaking && {
          connection: {
            host: 'localhost',
            port: 1883,
            clientId: 'console',
            username: null,
            useTls: false,
            connectedAt: '2026-09-10T00:00:00Z',
            sessionPresent: false,
            assignedClientId: null,
            serverKeepAlive: null,
            transport: 'tcp',
            protocolVersion: speaking,
          },
        }),
      }),
    ),
  );

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(<PublishPanel />, { wrapper });
}

beforeEach(() => {
  useLogStore.getState().clear();
  // How a message goes out lives in the store now, so it outlives a panel that has been unmounted
  // — which means it outlives a test too unless it is put back.
  useComposeStore.setState({ draft: null, qos: 0, retain: false });
});

describe('PublishPanel', () => {
  it('sends the topic, payload, QoS and retain flag', async () => {
    let sent: unknown;
    server.use(
      http.post('/api/publish', async ({ request }) => {
        sent = await request.json();
        return new HttpResponse(null, { status: 202 });
      }),
    );

    renderPanel();
    await userEvent.click(screen.getByRole('radio', { name: 'QoS 2' }));
    await userEvent.click(screen.getByLabelText('Retain'));
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));

    await waitFor(() =>
      expect(sent).toEqual({
        topic: 'sensors/temp',
        payload: '23.5',
        payloadEncoding: 'text',
        qos: 2,
        retain: true,
      }),
    );
  });

  // The log is the record of what the broker said, not of what this form asked it to do. A sent
  // message that the broker accepted comes back down the subscription like any other arrival, and
  // one that it dropped never existed — a row written here would claim traffic either way.
  it('writes nothing to the log when the publish is accepted', async () => {
    let accepted = false;
    server.use(
      http.post('/api/publish', () => {
        accepted = true;
        return new HttpResponse(null, { status: 202 });
      }),
    );

    renderPanel();
    await userEvent.click(screen.getByLabelText('Retain'));
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));

    await waitFor(() => expect(accepted).toBe(true));
    expect(useLogStore.getState().commands).toEqual([]);
  });

  it('ignores extra clicks fired while a publish is already in flight', async () => {
    let calls = 0;
    server.use(
      http.post('/api/publish', async () => {
        calls += 1;
        await delay(20);
        return new HttpResponse(null, { status: 202 });
      }),
    );

    renderPanel();
    const button = await screen.findByRole('button', { name: 'Publish' });
    await waitFor(() => expect(button).not.toBeDisabled());

    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(button).not.toBeDisabled());
    expect(calls).toBe(1);
  });

  // Folding the Publish region unmounts the panel — 'unmounted rather than hidden' is the
  // workspace's own rule — and a setting held in an unmounted component is a setting that goes
  // quietly back to nought while the reader is looking at something else.
  it('keeps the QoS and the retain flag across a fold and a reopen', async () => {
    const first = renderPanel();
    await userEvent.click(screen.getByRole('radio', { name: 'QoS 2' }));
    await userEvent.click(screen.getByLabelText('Retain'));

    first.unmount();
    renderPanel();

    expect(screen.getByRole('radio', { name: 'QoS 2' })).toBeChecked();
    expect(screen.getByLabelText('Retain')).toBeChecked();
  });

  it('logs a fault when publishing is refused', async () => {
    server.use(
      http.post('/api/publish', () =>
        HttpResponse.json(
          { title: 'Not connected', detail: 'Connect to a broker before publishing.' },
          { status: 400 },
        ),
      ),
    );

    renderPanel();
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));

    await waitFor(() =>
      expect(useLogStore.getState().commands[0]).toMatchObject({
        kind: 'fault',
        verb: 'Publish failed',
        topic: 'sensors/temp',
        body: 'Connect to a broker before publishing.',
      }),
    );
  });

  it('sends text bodies with the text encoding', async () => {
    let sent: unknown;
    server.use(
      http.post('/api/publish', async ({ request }) => {
        sent = await request.json();
        return new HttpResponse(null, { status: 202 });
      }),
    );

    renderPanel();
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));

    await waitFor(() =>
      expect(sent).toEqual({
        topic: 'sensors/temp',
        payload: '23.5',
        payloadEncoding: 'text',
        qos: 0,
        retain: false,
      }),
    );
  });

  it('sends what was typed as hex as base64', async () => {
    let sent: unknown;
    server.use(
      http.post('/api/publish', async ({ request }) => {
        sent = await request.json();
        return new HttpResponse(null, { status: 202 });
      }),
    );

    renderPanel();
    await userEvent.click(screen.getByRole('radio', { name: 'Hex' }));
    const box = screen.getByLabelText('Payload');
    await userEvent.clear(box);
    await userEvent.type(box, '01 A4 FF');
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));

    await waitFor(() =>
      expect(sent).toMatchObject({ payload: 'AaT/', payloadEncoding: 'base64' }),
    );
  });

  it('will not publish hex it cannot read, and says why', async () => {
    let called = false;
    server.use(
      http.post('/api/publish', () => {
        called = true;
        return new HttpResponse(null, { status: 202 });
      }),
    );

    renderPanel();
    await userEvent.click(screen.getByRole('radio', { name: 'Hex' }));
    const box = screen.getByLabelText('Payload');
    await userEvent.clear(box);
    await userEvent.type(box, 'ZZ');

    expect(await screen.findByText(/not a hex digit/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
    expect(called).toBe(false);
  });

  it('marks the payload box invalid and ties it to the error when the hex cannot be read', async () => {
    renderPanel();
    await userEvent.click(screen.getByRole('radio', { name: 'Hex' }));
    const box = screen.getByLabelText('Payload');
    await userEvent.clear(box);
    await userEvent.type(box, 'ZZ');

    const message = await screen.findByText(/not a hex digit/i);
    expect(box).toHaveAttribute('aria-invalid', 'true');
    expect(box).toHaveAttribute('aria-describedby', message.id);
    expect(message.id).toBeTruthy();
  });

  it('will not publish broken JSON', async () => {
    renderPanel();
    await userEvent.click(screen.getByRole('radio', { name: 'JSON' }));
    const box = screen.getByLabelText('Payload');
    await userEvent.clear(box);
    // `{{` is userEvent's escape for a literal `{`; see the note on the next test.
    await userEvent.type(box, '{{"a":}');

    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
  });

  it('formats JSON in place', async () => {
    renderPanel();
    await userEvent.click(screen.getByRole('radio', { name: 'JSON' }));
    const box = screen.getByLabelText('Payload');
    await userEvent.clear(box);
    await userEvent.type(box, '{{"a":1}');

    await userEvent.click(screen.getByRole('button', { name: 'Format' }));

    expect(box).toHaveValue('{\n  "a": 1\n}');
  });

  it('counts the bytes that will go out, not the characters typed', async () => {
    renderPanel();
    const box = screen.getByLabelText('Payload');
    await userEvent.clear(box);
    await userEvent.type(box, 'ö');

    expect(screen.getByText('2 bytes')).toBeInTheDocument();
  });

  describe('loaded from a click on a topic or a message', () => {
    const topic = () => screen.getByLabelText('Topic') as HTMLInputElement;
    const payload = () => screen.getByLabelText('Payload') as HTMLTextAreaElement;

    it('takes the topic and the payload off the draft', async () => {
      renderPanel();

      act(() => useComposeStore.getState().load({ topic: 'lab/oven', payload: '180' }));

      await waitFor(() => expect(topic().value).toBe('lab/oven'));
      expect(payload().value).toBe('180');
    });

    // A row in the log is a message somebody sent, and the console now sees it as it was sent —
    // it listens at the QoS ceiling and asks for retain as published. So loading one aims the
    // form at the whole message, and pressing Publish sends the same message again.
    it('takes the QoS and the retain flag off a draft that is a message', async () => {
      renderPanel();

      act(() =>
        useComposeStore
          .getState()
          .load({ topic: 'lab/oven', payload: '180', qos: 2, retain: true }),
      );

      await waitFor(() => expect(topic().value).toBe('lab/oven'));
      expect(screen.getByRole('radio', { name: 'QoS 2' })).toBeChecked();
      expect(screen.getByLabelText('Retain')).toBeChecked();
    });

    /*
     * The reported fault, and it was not the publish path at all.
     *
     * A branch of the tree has no message of its own, only the placeholders every node starts
     * with — and those used to be written into the form unconditionally. So ticking QoS 2 and
     * Retain and then clicking the tree to aim the form put both back to nought on the way past,
     * silently, before Publish was pressed. The message then went out at QoS 0 exactly as the log
     * said it had.
     */
    it('leaves the ticks alone for a draft that is a place rather than a message', async () => {
      renderPanel();

      await userEvent.click(screen.getByRole('radio', { name: 'QoS 2' }));
      await userEvent.click(screen.getByLabelText('Retain'));

      act(() => useComposeStore.getState().load({ topic: 'lab/oven', payload: '180' }));

      await waitFor(() => expect(topic().value).toBe('lab/oven'));
      expect(screen.getByRole('radio', { name: 'QoS 2' })).toBeChecked();
      expect(screen.getByLabelText('Retain')).toBeChecked();
    });

    // A branch node has a topic but no message of its own; overwriting the payload with nothing
    // would throw away what the user had typed.
    it('keeps the typed payload when the draft carries none', async () => {
      renderPanel();
      await userEvent.clear(payload());
      await userEvent.type(payload(), 'mine');

      act(() => useComposeStore.getState().load({ topic: 'lab' }));

      await waitFor(() => expect(topic().value).toBe('lab'));
      expect(payload().value).toBe('mine');
    });

    it('reloads on a second click of the same topic, after the form was edited', async () => {
      renderPanel();
      const draft = { topic: 'lab/oven', payload: '180' };
      act(() => useComposeStore.getState().load(draft));
      await waitFor(() => expect(topic().value).toBe('lab/oven'));

      await userEvent.clear(topic());
      await userEvent.type(topic(), 'something/else');
      act(() => useComposeStore.getState().load(draft));

      await waitFor(() => expect(topic().value).toBe('lab/oven'));
    });

    it('reloads a binary row in hex, and sends the same bytes again', async () => {
      let sent: unknown;
      server.use(
        http.post('/api/publish', async ({ request }) => {
          sent = await request.json();
          return new HttpResponse(null, { status: 202 });
        }),
      );

      renderPanel();
      act(() =>
        useComposeStore.getState().load({ topic: 'device/cmd', payload: '01 A4 FF', mode: 'hex' }),
      );

      expect(await screen.findByRole('radio', { name: 'Hex' })).toBeChecked();

      await userEvent.click(screen.getByRole('button', { name: 'Publish' }));

      await waitFor(() =>
        expect(sent).toMatchObject({ payload: 'AaT/', payloadEncoding: 'base64' }),
      );
    });

    it('leaves the mode alone for a draft that does not carry one', async () => {
      renderPanel();
      await userEvent.click(screen.getByRole('radio', { name: 'Hex' }));

      act(() => useComposeStore.getState().load({ topic: 'sensors/temp' }));

      await waitFor(() => expect(screen.getByRole('radio', { name: 'Hex' })).toBeChecked());
    });
  });

});

/**
 * What MQTT 5 lets a message carry.
 *
 * Offered on a 5.0 link and nowhere else: the API refuses a message carrying any of it over
 * 3.1.1 rather than sending one that has quietly lost its correlation id, so a form that let a
 * reader fill it in there would be a form that collects an error.
 */
describe('the MQTT 5 fold', () => {
  const sends = () => {
    const sent: unknown[] = [];
    server.use(
      http.post('/api/publish', async ({ request }) => {
        sent.push(await request.json());
        return new HttpResponse(null, { status: 202 });
      }),
    );

    return sent;
  };

  it('is not offered on a link speaking 3.1.1', async () => {
    renderPanel('v311');

    await waitFor(() => expect(screen.getByRole('button', { name: 'Publish' })).toBeEnabled());
    expect(screen.queryByTestId('mqtt5')).not.toBeInTheDocument();
  });

  it('is there, and shut, on a link speaking 5.0', async () => {
    renderPanel('v500');

    const fold = await screen.findByTestId('mqtt5');
    expect(fold).not.toHaveAttribute('open');
    expect(screen.getByText('MQTT 5')).toBeInTheDocument();
  });

  it('sends what was filled in, and nothing that was not', async () => {
    const sent = sends();
    renderPanel('v500');
    await userEvent.click(await screen.findByText('MQTT 5'));

    await userEvent.type(screen.getByLabelText('Content type'), 'application/json');
    await userEvent.type(screen.getByLabelText('Expiry'), '60');
    await userEvent.type(screen.getByLabelText('Response topic'), 'sensors/temp/reply');
    await userEvent.type(screen.getByLabelText('Correlation'), 'abc-123');
    await userEvent.type(
      screen.getByLabelText('Properties'),
      'source: console',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({
      topic: 'sensors/temp',
      payload: '23.5',
      payloadEncoding: 'text',
      qos: 0,
      retain: false,
      contentType: 'application/json',
      messageExpiryInterval: 60,
      responseTopic: 'sensors/temp/reply',
      correlationData: 'abc-123',
      userProperties: [{ name: 'source', value: 'console' }],
    });
  });

  // A fold opened and left alone is a fold nobody filled in.
  it('sends an ordinary publish when the fold was opened and nothing typed', async () => {
    const sent = sends();
    renderPanel('v500');
    await userEvent.click(await screen.findByText('MQTT 5'));

    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({
      topic: 'sensors/temp',
      payload: '23.5',
      payloadEncoding: 'text',
      qos: 0,
      retain: false,
    });
  });
});
