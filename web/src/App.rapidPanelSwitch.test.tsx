import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { delay, http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { createFakeHub } from './realtime/fakeHub';
import { server } from './test/server';

function renderApp() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <App hub={createFakeHub()} />
    </QueryClientProvider>,
  );
}

const menu = () => within(screen.getByRole('navigation', { name: 'Panels' }));

// Fast menu clicks switch away before a panel's own useQuery settles — the scenario
// React warns about with an unmounted-update or act() warning.
describe('rapid panel switching', () => {
  let errors: unknown[] = [];

  beforeEach(() => {
    errors = [];
    vi.spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(args);
    });
    server.use(
      http.get('/api/connection/settings', async () => {
        await delay(30);
        return new HttpResponse(null, { status: 204 });
      }),
      http.get('/api/subscriptions', async () => {
        await delay(30);
        return HttpResponse.json([]);
      }),
      // The colours panel seeds local state off this the moment it lands, which is the update
      // that has nowhere to go if the panel has already been switched away from.
      http.get('/api/colour-rules', async () => {
        await delay(30);
        return HttpResponse.json({ rules: [{ filter: 'sensors/#', colour: '#b45309' }] });
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not warn about updating an unmounted panel when the menu is clicked rapidly', async () => {
    renderApp();

    fireEvent.click(menu().getByRole('button', { name: 'Filters' }));
    fireEvent.click(menu().getByRole('button', { name: 'Broker' }));
    fireEvent.click(menu().getByRole('button', { name: 'Colours' }));
    fireEvent.click(menu().getByRole('button', { name: 'QR' }));
    fireEvent.click(menu().getByRole('button', { name: 'Settings' }));
    fireEvent.click(menu().getByRole('button', { name: 'Colours' }));
    fireEvent.click(menu().getByRole('button', { name: 'Filters' }));

    // Let in-flight requests from discarded panels settle.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });

    // React's own wording, not a blanket console.error check — React Query logs unrelated warnings too.
    const unmountWarnings = errors.filter((entry) =>
      /not wrapped in act|cannot update a component|unmounted component|memory leak/i.test(String(entry)),
    );
    expect(unmountWarnings).toEqual([]);
  });
});
