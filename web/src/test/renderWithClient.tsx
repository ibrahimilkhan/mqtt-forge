import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderOptions } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';

/**
 * `render` for anything that reaches the API through react-query.
 *
 * A fresh client per call, so nothing a test caches can reach the next one, and no retries —
 * a handler that answers with an error should fail the assertion, not be asked again.
 *
 * Test files that render such a component import this as `render`, which keeps their existing
 * call sites unchanged.
 */
export function renderWithClient(ui: ReactElement, options?: Omit<RenderOptions, 'wrapper'>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return render(ui, {
    ...options,
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}
