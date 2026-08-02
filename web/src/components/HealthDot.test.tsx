import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { server } from '../test/server';
import { HealthDot } from './HealthDot';

function renderDot() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(<HealthDot />, { wrapper });
}

describe('HealthDot', () => {
  it('starts out checking, before the first response arrives', () => {
    renderDot();

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(/checking/i);
  });

  it('reports healthy once the API answers', async () => {
    server.use(http.get('/api/health', () => HttpResponse.json({ status: 'ok' })));

    renderDot();

    expect(await screen.findByText(/healthy|online|ok/i)).toBeInTheDocument();
  });

  it('reports unreachable when the API cannot be reached', async () => {
    server.use(http.get('/api/health', () => HttpResponse.error()));

    renderDot();

    expect(await screen.findByText(/unreachable|down|offline/i)).toBeInTheDocument();
  });
});
