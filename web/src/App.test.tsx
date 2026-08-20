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

  it('keeps topics, the log, the chart and publish on screen whatever the menu is doing', () => {
    renderApp();

    expect(screen.getByRole('heading', { name: 'Topics' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Logs' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Chart' })).toBeInTheDocument();
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

  // A deep tree indents every level, so topics start widest; the panel column holds a form.
  it('starts with the topics column the widest of the three', () => {
    renderApp();

    expect(share('panel')).toBe('24.00fr');
    expect(share('tree')).toBe('44.00fr');
    expect(share('right')).toBe('32.00fr');
  });

  it('splits the closed panel column evenly between the other two', async () => {
    renderApp();

    await userEvent.click(menu().getByRole('button', { name: 'Broker' }));

    expect(screen.getByTestId('layout')).toHaveAttribute('data-panel', 'closed');
    expect(share('panel')).toBe('0.00fr');
    expect(share('tree')).toBe('56.00fr');
    expect(share('right')).toBe('44.00fr');
  });

  // A step is two percent of the pair the seam divides, not of the whole row — the same
  // relationship the pointer has to it, and the reason these numbers are not round.
  it('puts the panel column back the width it was when it reopens', async () => {
    renderApp();

    const seam = screen.getByRole('separator', { name: 'Panel and topics boundary' });
    seam.focus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(share('panel')).toBe('22.64fr');

    await userEvent.click(menu().getByRole('button', { name: 'Broker' }));
    await userEvent.click(menu().getByRole('button', { name: 'Broker' }));

    expect(share('panel')).toBe('22.64fr');
  });

  it('moves the topics boundary with the arrow keys', async () => {
    renderApp();

    const seam = screen.getByRole('separator', { name: 'Topics and log boundary' });
    seam.focus();
    await userEvent.keyboard('{ArrowRight}');

    expect(share('tree')).toBe('45.52fr');
    expect(share('right')).toBe('30.48fr');
  });

  // Unmeasured in jsdom, so the column opens content-sized: the entries and the publish form
  // take the heights they need and the chart gets the rest. The first drag is what puts it onto
  // shares.
  it('opens the right column sized to its two ends, then splits on drag', async () => {
    renderApp();

    expect(screen.getByTestId('right-column')).toHaveAttribute('data-fit', 'content');

    const seam = screen.getByRole('separator', { name: 'Log and chart boundary' });
    seam.focus();
    await userEvent.keyboard('{ArrowUp}');

    expect(screen.getByTestId('right-column')).toHaveAttribute('data-fit', 'split');
    expect(share('log')).toBe('28.60fr');
    expect(share('chart')).toBe('41.40fr');
    expect(share('publish')).toBe('30.00fr');
  });

  // Two boundaries, and each one moves only the two regions it divides — dragging the chart off
  // the publish form must not also move the entries above it.
  it('leaves the entries where they were when the lower seam moves', async () => {
    renderApp();

    const seam = screen.getByRole('separator', { name: 'Chart and publish boundary' });
    seam.focus();
    await userEvent.keyboard('{ArrowUp}');

    expect(share('log')).toBe('30.00fr');
    expect(share('chart')).toBe('38.60fr');
    expect(share('publish')).toBe('31.40fr');
  });

  // The control that narrows the rail lives in the rail, since there is no bar above it any more
  // and a rail that took its own way back with it would be a one-way door.
  it('narrows the rail and opens it again from inside the rail', async () => {
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

  // The bar carried the state across the top; the rail carries it now, and narrowed it keeps it
  // as a lamp with the word on the element rather than dropping the state altogether.
  it('keeps the connection state readable with the rail narrowed', async () => {
    renderApp();
    await screen.findByText('DISCONNECTED');

    await userEvent.click(screen.getByRole('button', { name: 'Panel menu' }));

    expect(screen.queryByText('DISCONNECTED')).not.toBeInTheDocument();
    expect(screen.getByLabelText('DISCONNECTED')).toBeInTheDocument();
  });

  // The chart's region is a third of a column that is itself a third of the window. Thrown open
  // it leaves the column entirely, which no share of a grid track can express.
  it('takes the window when the chart is thrown open', async () => {
    renderApp();

    const pane = () => screen.getByRole('heading', { name: 'Chart' }).closest('section')!;
    expect(pane()).not.toHaveAttribute('data-zoomed');

    await userEvent.click(
      screen.getByRole('button', { name: 'Open the chart over the console' }),
    );

    expect(pane()).toHaveAttribute('data-zoomed');
  });

  // There were six marks and a row of them in Settings to choose between. Six marks is six
  // answers to a question a tool should answer once, and the choosing was work asked of a reader
  // who came to watch a broker.
  it('wears one mark, with nothing in Settings offering another', async () => {
    renderApp();

    await userEvent.click(menu().getByRole('button', { name: 'Settings' }));

    expect(screen.queryByRole('group', { name: 'Mark' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'MQTTForge' })).toBeInTheDocument();
  });
});
