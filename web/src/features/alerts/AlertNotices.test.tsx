import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { createFakeHub } from '../../realtime/fakeHub';
import { useAlertStore } from '../../stores/alertStore';
import { useAppearanceStore } from '../../stores/appearanceStore';
import { server } from '../../test/server';
import type { AlertDto } from '../../types/api';
import { useSoundStore } from './alertSound';
import { AlertNotices } from './AlertNotices';

const alertOf = (id: string, over: Partial<AlertDto> = {}): AlertDto => ({
  id,
  ruleId: 'r1',
  ruleName: 'Kiln too hot',
  topic: 'sensors/kiln/temp',
  severity: 'critical',
  firedAt: new Date().toISOString(),
  lastSeenAt: new Date().toISOString(),
  resolvedAt: null,
  resolvedBy: null,
  mutedUntil: null,
  count: 1,
  reason: 'value 91.4 over 90',
  value: 91.4,
  sample: null,
  actions: ['screen'],
  ...over,
});

/** What the server says is happening, for the tests that mount the whole app. */
function answers(active: AlertDto[]) {
  server.use(
    http.get('/api/alerts', () =>
      HttpResponse.json({
        active,
        history: [],
        muted: [],
        rules: [],
        warming: [],
        dropped: 0,
        webhooksDropped: 0,
        suppressed: 0,
        capped: [],
        blindSeconds: 0,
      }),
    ),
  );
}

const empty = {
  active: [] as AlertDto[],
  history: [] as AlertDto[],
  rules: [],
  warming: [],
  dropped: 0,
  webhooksDropped: 0,
  suppressed: 0,
  capped: [],
  blindSeconds: 0,
};

beforeEach(() => {
  useAlertStore.setState(empty);
  useAppearanceStore.setState({ alertSound: false, health: false });
  // No gesture has happened in a fresh test, and the armed flag is not persisted — set it back
  // anyway, so a test that arms it cannot reach the one after it.
  useSoundStore.setState({ armed: false });
});

const notices = () => screen.queryAllByTestId('alert-notice');
const menu = () => within(screen.getByRole('navigation', { name: 'Panels' }));

function renderApp() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <App hub={createFakeHub()} />
    </QueryClientProvider>,
  );
}

describe('the corner notices', () => {
  it('leaves the corner alone for the alarms that were already standing', () => {
    // The state of the world when the console opened, not four things that just happened.
    useAlertStore.setState({ active: [alertOf('a1'), alertOf('a2')] });
    render(<AlertNotices open={vi.fn()} />);

    expect(notices()).toHaveLength(0);

    act(() => useAlertStore.setState({ active: [alertOf('a1'), alertOf('a2'), alertOf('a3')] }));

    expect(notices()).toHaveLength(1);
  });

  it('shows a critical as an alert, and it says so in words', () => {
    render(<AlertNotices open={vi.fn()} />);

    act(() => useAlertStore.setState({ active: [alertOf('a1')] }));

    const notice = screen.getByTestId('alert-notice');
    expect(notice).toHaveAttribute('role', 'alert');
    expect(within(notice).getByText('critical')).toBeInTheDocument();
    expect(within(notice).getByText('sensors/kiln/temp')).toBeInTheDocument();
    expect(within(notice).getByText('Kiln too hot')).toBeInTheDocument();
    expect(within(notice).getByText('value 91.4 over 90')).toBeInTheDocument();
  });

  it('lets a critical be dismissed, and only then', async () => {
    render(<AlertNotices open={vi.fn()} />);
    act(() => useAlertStore.setState({ active: [alertOf('a1')] }));

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss the Kiln too hot alert' }));

    expect(notices()).toHaveLength(0);
  });

  // An alert the engine no longer holds cannot be opened, muted or resolved, so a notice
  // standing over one is a phantom alarm in a different coat. It goes out with the alarm.
  it('takes a notice away with the alarm it is about, critical included', () => {
    render(<AlertNotices open={vi.fn()} />);
    act(() => useAlertStore.setState({ active: [alertOf('a1')] }));
    expect(notices()).toHaveLength(1);

    act(() => useAlertStore.setState({ active: [] }));

    expect(notices()).toHaveLength(0);
  });

  describe('and how long they stay', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('lets a warning go by itself, as a status rather than an alert', () => {
      render(<AlertNotices open={vi.fn()} />);
      act(() => useAlertStore.setState({ active: [alertOf('a1', { severity: 'warn' })] }));

      expect(screen.getByTestId('alert-notice')).toHaveAttribute('role', 'status');

      act(() => vi.advanceTimersByTime(6000));

      expect(notices()).toHaveLength(0);
    });

    it('keeps a critical however long it is left', () => {
      render(<AlertNotices open={vi.fn()} />);
      act(() => useAlertStore.setState({ active: [alertOf('a1')] }));

      act(() => vi.advanceTimersByTime(600_000));

      expect(notices()).toHaveLength(1);
    });
  });
});

describe('the badge on the rail', () => {
  it('counts what is standing and wears the loudest level, with the health line off', async () => {
    answers([alertOf('a1'), alertOf('a2', { severity: 'warn' })]);
    renderApp();

    // The whole reason the badge is here rather than only on the health strip.
    expect(useAppearanceStore.getState().health).toBe(false);

    const badge = await menu().findByTestId('alert-badge');
    expect(badge).toHaveTextContent('2');
    expect(badge).toHaveAttribute('data-severity', 'critical');
    // And in the row's own name, for a reader who never sees the colour at all.
    expect(menu().getByRole('button', { name: /Alerts, 2 alerting, worst critical/ })).toBeInTheDocument();
  });

  it('takes a fourth alarm onto the badge without taking it into the corner', async () => {
    answers([alertOf('a1')]);
    renderApp();
    // Waiting on the badge proves the first snapshot has landed and been taken as the state of
    // the world; everything after it is news.
    expect(await menu().findByTestId('alert-badge')).toHaveTextContent('1');

    act(() =>
      useAlertStore
        .getState()
        .raised([alertOf('a2'), alertOf('a3'), alertOf('a4'), alertOf('a5')]),
    );

    expect(notices()).toHaveLength(3);
    expect(menu().getByTestId('alert-badge')).toHaveTextContent('5');
  });

  it('is not there at all when nothing is alarming', async () => {
    renderApp();

    await menu().findByRole('button', { name: 'Alerts' });
    expect(menu().queryByTestId('alert-badge')).not.toBeInTheDocument();
  });

  it('says the sound is wanted but not ready', async () => {
    useAppearanceStore.setState({ alertSound: true });
    renderApp();

    expect(await menu().findByRole('button', { name: 'Alerts' })).toHaveAttribute(
      'title',
      'Sound is not ready — click to turn it on',
    );
  });
});

describe('a notice as a way in', () => {
  it('opens the panel it is about', async () => {
    answers([]);
    renderApp();
    await menu().findByRole('button', { name: 'Alerts' });

    act(() => useAlertStore.getState().raised([alertOf('a1')]));
    await userEvent.click(screen.getByRole('button', { name: /Open the Kiln too hot alert/ }));

    expect(screen.getByRole('region', { name: 'Alerts panel' })).toBeInTheDocument();
  });
});
