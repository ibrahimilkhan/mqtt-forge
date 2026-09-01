import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { server } from './test/server';
import { App } from './App';
import { createFakeHub } from './realtime/fakeHub';
import { useHubStatusStore } from './stores/hubStatusStore';

afterEach(() => useHubStatusStore.setState({ status: 'live' }));

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

// The app opens on the broker panel, which takes the whole workspace — so the columns it covers
// are not on screen while it is up. Anything about those columns swaps it for a panel that lives
// in one, which is every other panel there is.
const intoColumns = () => userEvent.click(menu().getByRole('button', { name: 'Filters' }));

describe('App', () => {
  it('opens the broker panel first, since connecting comes before everything else', async () => {
    renderApp();

    expect(await menu().findByRole('button', { name: 'Broker' })).toHaveAttribute('aria-expanded', 'true');
  });

  // The one panel that covers them, and the reason: nothing in the tree or the log means
  // anything until the connection the broker panel describes is up.
  it('gives the broker panel the whole workspace', async () => {
    renderApp();

    await menu().findByRole('button', { name: 'Broker' });
    expect(screen.getByTestId('layout')).toHaveAttribute('data-panel', 'full');
    expect(
      screen.queryByRole('separator', { name: 'Panel and topics boundary' }),
    ).not.toBeInTheDocument();
  });

  it('gives the columns back to any other panel', async () => {
    renderApp();
    await intoColumns();

    expect(screen.getByTestId('layout')).toHaveAttribute('data-panel', 'open');
    expect(screen.getByRole('separator', { name: 'Panel and topics boundary' })).toBeInTheDocument();
  });

  it('keeps topics, the log, the chart and publish on screen whatever the menu is doing', async () => {
    renderApp();
    await intoColumns();

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
    await intoColumns();

    const seam = screen.getByRole('separator', { name: 'Panel and topics boundary' });
    seam.focus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(share('panel')).toBe('22.64fr');

    await intoColumns();
    await intoColumns();

    expect(share('panel')).toBe('22.64fr');
  });

  it('moves the topics boundary with the arrow keys', async () => {
    renderApp();
    await intoColumns();

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
    await intoColumns();

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
    await intoColumns();

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

    expect(screen.getByRole('button', { name: 'Panel menu' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );

    await userEvent.click(screen.getByRole('button', { name: 'Panel menu' }));

    expect(screen.getByRole('button', { name: 'Panel menu' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  // Narrowing the rail used to take the menu with it: every panel in the app was then behind the
  // toggle and a second click. The icons stay at both widths, so what narrowing costs is the
  // words rather than the way in.
  it('keeps every panel reachable with the rail narrowed', async () => {
    renderApp();
    await userEvent.click(screen.getByRole('button', { name: 'Panel menu' }));

    expect(menu().getAllByRole('button')).toHaveLength(7);

    await userEvent.click(menu().getByRole('button', { name: 'Filters' }));

    expect(screen.getByRole('region', { name: 'Filters panel' })).toBeInTheDocument();
  });

  // The label is off the page, so each button has to carry its own name.
  it('drops the labels when the rail narrows, and keeps them on the buttons', async () => {
    renderApp();
    expect(menu().getByRole('button', { name: 'Broker' })).toHaveTextContent('Broker');

    await userEvent.click(screen.getByRole('button', { name: 'Panel menu' }));

    expect(menu().getByRole('button', { name: 'Broker' })).toHaveTextContent('');
    expect(menu().queryByRole('heading', { name: 'Link' })).not.toBeInTheDocument();
  });

  // Six flat buttons was a list to read through, and seven is more so. The headings are the
  // questions a reader actually arrives with, and Chart leads Reading because that is where a
  // topic is read. Alerts closes it: a rule is written about a run already being watched.
  it('groups the panels under headings, in the order they are worked through', () => {
    renderApp();

    expect(menu().getAllByRole('heading').map((heading) => heading.textContent)).toEqual([
      'Link',
      'Reading',
      'Tools',
    ]);
    expect(menu().getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Broker',
      'Filters',
      'Chart',
      'Colours',
      'Alerts',
      'QR',
      'Settings',
    ]);
  });

  // The chart's region is a third of a column that is itself a third of the window. Thrown open
  // it leaves the column entirely, which no share of a grid track can express.
  it('takes the window when the chart is thrown open', async () => {
    renderApp();
    await intoColumns();

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

// The link's state, worn by the row that leads to the panel that can do something about it —
// and worn nowhere else. There used to be a lamp and a word at the top of the rail saying the
// same thing in a different vocabulary.
describe('the Broker row, as the only readout', () => {
  const brokerRow = () => menu().getByRole('button', { name: /^Broker/ });

  const link = {
    host: 'broker.example',
    port: 1883,
    clientId: 'console',
    username: null,
    useTls: false,
    connectedAt: '2026-08-24T12:00:00Z',
    sessionPresent: false,
    assignedClientId: null,
    serverKeepAlive: null,
  };

  const failure = {
    reason: 'refused',
    host: 'broker.example',
    port: 1883,
    clientId: 'console',
    useTls: false,
    transport: 'tcp',
    protocolVersion: 'auto',
  };

  const linked = (state: string, extra: Record<string, unknown> = {}) =>
    server.use(http.get('/api/connection', () => HttpResponse.json({ state, ...extra })));

  it('says the state nowhere else', async () => {
    renderApp();

    await waitFor(() => expect(brokerRow()).toHaveAttribute('data-link', 'Disconnected'));
    expect(screen.queryByText('DISCONNECTED')).not.toBeInTheDocument();
  });

  it('wears nothing at rest, having been asked to do nothing yet', async () => {
    renderApp();

    await waitFor(() => expect(brokerRow()).toHaveAttribute('data-link', 'Disconnected'));
    // No state in the name either: there is nothing to say.
    expect(menu().getByRole('button', { name: 'Broker' })).toBeInTheDocument();
  });

  it('goes green on a live link, and says so out loud', async () => {
    linked('Connected', { connection: link });
    renderApp();

    await waitFor(() => expect(brokerRow()).toHaveAttribute('data-link', 'Connected'));
    expect(menu().getByRole('button', { name: 'Broker, connected' })).toBeInTheDocument();
  });

  // The address had a line of its own under the rail's readout. It is reachable without opening
  // the panel, which is what that line was for.
  it('carries the broker it is pointed at', async () => {
    linked('Connected', { connection: link });
    renderApp();

    await waitFor(() => expect(brokerRow()).toHaveAttribute('title', 'Broker · broker.example:1883'));
  });

  it('goes red on a fault, and says so out loud', async () => {
    linked('Faulted', { failure });
    renderApp();

    await waitFor(() => expect(brokerRow()).toHaveAttribute('data-link', 'Faulted'));
    expect(menu().getByRole('button', { name: 'Broker, connection faulted' })).toBeInTheDocument();
  });

  // In flight is not yet an answer, and saying so in green would be a lie for up to twenty
  // seconds.
  it('says neither while an attempt is in flight', async () => {
    linked('Connecting');
    renderApp();

    await waitFor(() => expect(brokerRow()).toHaveAttribute('data-link', 'Waiting'));
  });

  // The hub, not the broker — but the reader's question is the same one, and the answer is the
  // same too: nothing on this screen is currently proven.
  it('shows the hub reconnecting on the same row', async () => {
    linked('Connected', { connection: link });
    renderApp();
    await waitFor(() => expect(brokerRow()).toHaveAttribute('data-link', 'Connected'));

    act(() => useHubStatusStore.setState({ status: 'reconnecting' }));

    await waitFor(() => expect(brokerRow()).toHaveAttribute('data-link', 'Reconnecting'));
    expect(menu().getByRole('button', { name: 'Broker, reconnecting' })).toBeInTheDocument();
  });

  it('goes back to the broker state once the hub returns', async () => {
    linked('Connected', { connection: link });
    renderApp();
    act(() => useHubStatusStore.setState({ status: 'reconnecting' }));
    await waitFor(() => expect(brokerRow()).toHaveAttribute('data-link', 'Reconnecting'));

    act(() => useHubStatusStore.setState({ status: 'live' }));

    await waitFor(() => expect(brokerRow()).toHaveAttribute('data-link', 'Connected'));
  });

  it('keeps the state on the row when the rail is narrowed', async () => {
    linked('Faulted', { failure });
    renderApp();
    await waitFor(() => expect(brokerRow()).toHaveAttribute('data-link', 'Faulted'));

    await userEvent.click(screen.getByRole('button', { name: 'Panel menu' }));

    expect(menu().getByRole('button', { name: 'Broker, connection faulted' })).toBeInTheDocument();
  });
});
