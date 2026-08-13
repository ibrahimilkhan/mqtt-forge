import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
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

// The open panel has buttons of its own that share names with the menu, so every menu
// query is scoped to the menu itself.
const menu = () => within(screen.getByRole('navigation', { name: 'Panels' }));

// Column widths are what the layout exposes, so that is what gets asserted.
const share = (name: string) =>
  screen.getByTestId('layout').style.getPropertyValue(`--${name}`);

describe('App', () => {
  it('opens the broker panel first, since connecting comes before everything else', async () => {
    renderApp();

    expect(await menu().findByRole('button', { name: 'Broker' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('keeps topics, the log and publish on screen whatever the menu is doing', () => {
    renderApp();

    expect(screen.getByRole('heading', { name: 'Topics' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Logs' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Publish panel' })).toBeInTheDocument();
  });

  it('leaves publish without a close button, since it has nowhere to go', () => {
    renderApp();

    expect(screen.queryByRole('button', { name: 'Close Publish panel' })).not.toBeInTheDocument();
  });

  it('keeps one panel in the first column at a time', async () => {
    renderApp();

    await userEvent.click(menu().getByRole('button', { name: 'Filters' }));

    expect(menu().getByRole('button', { name: 'Filters' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(menu().getByRole('button', { name: 'Broker' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('region', { name: 'Filters panel' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Broker panel' })).not.toBeInTheDocument();
  });

  it('reaches the mobile panel from the menu', async () => {
    renderApp();

    await userEvent.click(menu().getByRole('button', { name: 'QR' }));

    expect(screen.getByRole('region', { name: 'QR panel' })).toBeInTheDocument();
  });

  it('reaches the colours panel from the menu', async () => {
    renderApp();

    await userEvent.click(menu().getByRole('button', { name: 'Colours' }));

    expect(screen.getByRole('region', { name: 'Colours panel' })).toBeInTheDocument();
  });

  it('reaches the settings panel from the menu', async () => {
    renderApp();

    await userEvent.click(menu().getByRole('button', { name: 'Settings' }));

    expect(screen.getByRole('region', { name: 'Settings panel' })).toBeInTheDocument();
  });

  // The tree and the log carry long topic names and payloads; the panel column holds a form.
  it('starts with the panel column the narrowest of the three', () => {
    renderApp();

    expect(share('panel')).toBe('26.00fr');
    expect(share('tree')).toBe('36.00fr');
    expect(share('right')).toBe('38.00fr');
  });

  it('splits the closed panel column evenly between the other two', async () => {
    renderApp();

    await userEvent.click(menu().getByRole('button', { name: 'Broker' }));

    expect(screen.getByTestId('layout')).toHaveAttribute('data-panel', 'closed');
    expect(share('panel')).toBe('0.00fr');
    expect(share('tree')).toBe('49.00fr');
    expect(share('right')).toBe('51.00fr');
  });

  it('puts the panel column back the width it was when it reopens', async () => {
    renderApp();

    const seam = screen.getByRole('separator', { name: 'Panel and topics boundary' });
    seam.focus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(share('panel')).toBe('24.00fr');

    await userEvent.click(menu().getByRole('button', { name: 'Broker' }));
    await userEvent.click(menu().getByRole('button', { name: 'Broker' }));

    expect(share('panel')).toBe('24.00fr');
  });

  it('moves the topics boundary with the arrow keys', async () => {
    renderApp();

    const seam = screen.getByRole('separator', { name: 'Topics and log boundary' });
    seam.focus();
    await userEvent.keyboard('{ArrowRight}');

    expect(share('tree')).toBe('38.00fr');
    expect(share('right')).toBe('36.00fr');
  });

  // Unmeasured in jsdom, so the column opens content-sized: publish takes the height its form
  // needs and the log gets the rest. The first drag is what puts it onto shares.
  it('opens the right column sized to the publish form, then splits on drag', async () => {
    renderApp();

    expect(screen.getByTestId('right-column')).toHaveAttribute('data-fit', 'content');

    const seam = screen.getByRole('separator', { name: 'Log and publish boundary' });
    seam.focus();
    await userEvent.keyboard('{ArrowUp}');

    expect(screen.getByTestId('right-column')).toHaveAttribute('data-fit', 'split');
    expect(share('log')).toBe('58.00fr');
    expect(share('publish')).toBe('42.00fr');
  });

  it('folds the menu away and brings it back from the bar', async () => {
    renderApp();

    await userEvent.click(screen.getByRole('button', { name: 'Panel menu' }));

    expect(screen.queryByRole('navigation', { name: 'Panels' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Panel menu' }));

    expect(screen.getByRole('navigation', { name: 'Panels' })).toBeInTheDocument();
  });

  it('shows the connection state read from the API', async () => {
    renderApp();

    expect(await screen.findByText('DISCONNECTED')).toBeInTheDocument();
  });
});
