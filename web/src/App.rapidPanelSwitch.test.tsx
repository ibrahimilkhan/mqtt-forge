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

// A panel mounts a useQuery for its own data; switching away before that request settles is
// exactly what a fast click through the menu produces, and is the scenario React warns about
// with "Cannot update a component while rendering a different component" or an act() warning.
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
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not warn about updating an unmounted panel when the menu is clicked rapidly', async () => {
    renderApp();

    fireEvent.click(menu().getByRole('button', { name: 'Subscribe' }));
    fireEvent.click(menu().getByRole('button', { name: 'Publish' }));
    fireEvent.click(menu().getByRole('button', { name: 'Broker' }));
    fireEvent.click(menu().getByRole('button', { name: 'Mobile' }));
    fireEvent.click(menu().getByRole('button', { name: 'Settings' }));

    // Let every in-flight request from the discarded panels settle.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });

    // React's own wording for a setState reaching an unmounted tree or a render outside
    // act() - not a blanket console.error check, since React Query logs unrelated dev
    // warnings of its own that have nothing to do with rapid panel switching.
    const unmountWarnings = errors.filter((entry) =>
      /not wrapped in act|cannot update a component|unmounted component|memory leak/i.test(String(entry)),
    );
    expect(unmountWarnings).toEqual([]);
  });
});
