import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from './App';
import { createFakeHub } from './realtime/fakeHub';

function renderApp() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <App hub={createFakeHub()} />
    </QueryClientProvider>,
  );
}

describe('App', () => {
  it('opens the broker panel first, since connecting comes before everything else', async () => {
    renderApp();

    expect(await screen.findByRole('button', { name: 'Broker' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('keeps one panel open at a time', async () => {
    renderApp();

    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));

    expect(screen.getByRole('button', { name: 'Publish' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Broker' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes the open panel when its menu button is clicked again', async () => {
    renderApp();

    await userEvent.click(screen.getByRole('button', { name: 'Broker' }));

    expect(screen.getByRole('button', { name: 'Broker' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('layout')).toHaveAttribute('data-panel', 'closed');
  });

  it('shows the connection state read from the API', async () => {
    renderApp();

    expect(await screen.findByText('DISCONNECTED')).toBeInTheDocument();
  });
});
