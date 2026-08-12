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

function renderPanel() {
  // Publish button is disabled without a live broker.
  server.use(http.get('/api/connection', () => HttpResponse.json({ state: 'Connected' })));

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(<PublishPanel />, { wrapper });
}

beforeEach(() => {
  useLogStore.getState().clear();
  useComposeStore.setState({ draft: null });
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
    // Waits for the mutation's own onSuccess so it can't fire during a later test.
    await waitFor(() => expect(useLogStore.getState().entries).toHaveLength(1));
  });

  it('logs what it sent, stamped with QoS and RETAINED', async () => {
    server.use(http.post('/api/publish', () => new HttpResponse(null, { status: 202 })));

    renderPanel();
    await userEvent.click(screen.getByLabelText('Retain'));
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));

    await waitFor(() =>
      expect(useLogStore.getState().entries[0]).toMatchObject({
        kind: 'sent',
        verb: 'Published',
        topic: 'sensors/temp',
        body: '23.5',
        stamps: ['QoS 0', 'RETAINED'],
      }),
    );
  });

  // The row's stamps say QoS 2 RETAINED; clicking it to re-publish has to send the same again.
  it('records the QoS and retain flag it sent, so the row re-publishes as it went out', async () => {
    server.use(http.post('/api/publish', () => new HttpResponse(null, { status: 202 })));

    renderPanel();
    await userEvent.click(screen.getByRole('radio', { name: 'QoS 2' }));
    await userEvent.click(screen.getByLabelText('Retain'));
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));

    await waitFor(() =>
      expect(useLogStore.getState().entries[0]).toMatchObject({ qos: 2, retain: true }),
    );
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
    // Let the settled mutation's own log entry land before the test ends.
    await waitFor(() => expect(useLogStore.getState().entries).toHaveLength(1));
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
      expect(useLogStore.getState().entries[0]).toMatchObject({
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

  it('stamps a hex publish as binary in the log', async () => {
    server.use(http.post('/api/publish', () => new HttpResponse(null, { status: 202 })));

    renderPanel();
    await userEvent.click(screen.getByRole('radio', { name: 'Hex' }));
    const box = screen.getByLabelText('Payload');
    await userEvent.clear(box);
    await userEvent.type(box, '01 A4 FF');
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));

    await waitFor(() =>
      expect(useLogStore.getState().entries[0]).toMatchObject({
        kind: 'sent',
        body: '01 A4 FF',
        mode: 'hex',
        stamps: ['QoS 0', 'BIN'],
      }),
    );
  });

  describe('loaded from a click on a topic or a message', () => {
    const topic = () => screen.getByLabelText('Topic') as HTMLInputElement;
    const payload = () => screen.getByLabelText('Payload') as HTMLTextAreaElement;

    it('takes the topic, payload, QoS and retain flag off the draft', async () => {
      renderPanel();

      act(() =>
        useComposeStore.getState().load({ topic: 'lab/oven', payload: '180', qos: 2, retain: true }),
      );

      await waitFor(() => expect(topic().value).toBe('lab/oven'));
      expect(payload().value).toBe('180');
      expect(screen.getByRole('radio', { name: 'QoS 2' })).toBeChecked();
      expect(screen.getByLabelText('Retain')).toBeChecked();
    });

    // A branch node has a topic but no message of its own; overwriting the payload with nothing
    // would throw away what the user had typed.
    it('keeps the typed payload when the draft carries none', async () => {
      renderPanel();
      await userEvent.clear(payload());
      await userEvent.type(payload(), 'mine');

      act(() => useComposeStore.getState().load({ topic: 'lab', qos: 0, retain: false }));

      await waitFor(() => expect(topic().value).toBe('lab'));
      expect(payload().value).toBe('mine');
    });

    it('reloads on a second click of the same topic, after the form was edited', async () => {
      renderPanel();
      const draft = { topic: 'lab/oven', payload: '180', qos: 0, retain: false };
      act(() => useComposeStore.getState().load(draft));
      await waitFor(() => expect(topic().value).toBe('lab/oven'));

      await userEvent.clear(topic());
      await userEvent.type(topic(), 'something/else');
      act(() => useComposeStore.getState().load(draft));

      await waitFor(() => expect(topic().value).toBe('lab/oven'));
    });
  });
});
