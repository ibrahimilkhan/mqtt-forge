import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useLogStore } from '../../stores/logStore';
import { server } from '../../test/server';
import { PublishPanel } from './PublishPanel';

function renderPanel() {
  // Publishing needs a live broker; without one the button is disabled by design.
  server.use(http.get('/api/connection', () => HttpResponse.json({ state: 'Connected' })));

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(<PublishPanel onClose={vi.fn()} />, { wrapper });
}

beforeEach(() => useLogStore.getState().clear());

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
      expect(sent).toEqual({ topic: 'sensors/temp', payload: '23.5', qos: 2, retain: true }),
    );
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
});
