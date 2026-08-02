import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useLogStore } from '../../stores/logStore';
import { server } from '../../test/server';
import { SubscribePanel } from './SubscribePanel';

function renderPanel() {
  // Subscribing needs a live broker; without one the button is disabled by design.
  server.use(http.get('/api/connection', () => HttpResponse.json({ state: 'Connected' })));

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(<SubscribePanel onClose={vi.fn()} />, { wrapper });
}

beforeEach(() => useLogStore.getState().clear());

describe('SubscribePanel', () => {
  it('lists the active filters', async () => {
    server.use(http.get('/api/subscriptions', () => HttpResponse.json(['sensors/#', 'devices/+/state'])));

    renderPanel();

    expect(await screen.findByText('sensors/#')).toBeInTheDocument();
    expect(screen.getByText('devices/+/state')).toBeInTheDocument();
  });

  it('sends the filter and the chosen QoS', async () => {
    let sent: unknown;
    server.use(
      http.post('/api/subscriptions', async ({ request }) => {
        sent = await request.json();
        return new HttpResponse(null, { status: 202 });
      }),
    );

    renderPanel();
    await userEvent.click(await screen.findByRole('radio', { name: 'QoS 1' }));
    await userEvent.click(screen.getByRole('button', { name: 'Subscribe' }));

    await waitFor(() => expect(sent).toEqual({ topicFilter: 'sensors/#', qos: 1 }));
  });

  it('unsubscribes from the chip that was dismissed', async () => {
    let removed: string | null = null;
    server.use(
      http.get('/api/subscriptions', () => HttpResponse.json(['sensors/#'])),
      http.delete('/api/subscriptions', ({ request }) => {
        removed = new URL(request.url).searchParams.get('topicFilter');
        return new HttpResponse(null, { status: 204 });
      }),
    );

    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'Unsubscribe from sensors/#' }));

    await waitFor(() => expect(removed).toBe('sensors/#'));
  });

  it('logs the subscription with its QoS stamp', async () => {
    server.use(http.post('/api/subscriptions', () => new HttpResponse(null, { status: 202 })));

    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'Subscribe' }));

    await waitFor(() =>
      expect(useLogStore.getState().entries[0]).toMatchObject({
        kind: 'ok',
        verb: 'Subscribed',
        topic: 'sensors/#',
        stamps: ['QoS 0'],
      }),
    );
  });

  it('logs a fault when the broker is not connected', async () => {
    server.use(
      http.post('/api/subscriptions', () =>
        HttpResponse.json(
          { title: 'Not connected', detail: 'Connect to a broker before subscribing.' },
          { status: 400 },
        ),
      ),
    );

    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'Subscribe' }));

    await waitFor(() =>
      expect(useLogStore.getState().entries[0]).toMatchObject({
        kind: 'fault',
        verb: 'Subscribe failed',
        body: 'Connect to a broker before subscribing.',
      }),
    );
  });

  it('ignores extra clicks fired while a subscribe is already in flight', async () => {
    let calls = 0;
    server.use(
      http.post('/api/subscriptions', async () => {
        calls += 1;
        await delay(20);
        return new HttpResponse(null, { status: 202 });
      }),
    );

    renderPanel();
    const button = await screen.findByRole('button', { name: 'Subscribe' });
    await waitFor(() => expect(button).not.toBeDisabled());

    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(button).not.toBeDisabled());
    expect(calls).toBe(1);
  });

  it('ignores extra clicks on the same chip while its unsubscribe is already in flight', async () => {
    let calls = 0;
    server.use(
      http.get('/api/subscriptions', () => HttpResponse.json(['sensors/#'])),
      http.delete('/api/subscriptions', async () => {
        calls += 1;
        await delay(20);
        return new HttpResponse(null, { status: 204 });
      }),
    );

    renderPanel();
    const button = await screen.findByRole('button', { name: 'Unsubscribe from sensors/#' });

    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(calls).toBe(1));
  });
});
