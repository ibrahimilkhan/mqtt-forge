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
import { AlertWall } from './AlertWall';

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

const rows = () => screen.queryAllByTestId('alert-wall-row');
const menu = () => within(screen.getByRole('navigation', { name: 'Panels' }));

function renderApp() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <App hub={createFakeHub()} />
    </QueryClientProvider>,
  );
}

describe('the alarm wall', () => {
  // The corner stack held the opposite rule: what was already standing when the console opened
  // was the state of the world rather than news, and it drew nothing. A wall is not telling
  // anybody anything — it is showing what is on fire, and that includes the fires it walked in on.
  it('stands up the alarms the console opened onto, not only the ones that arrive after', () => {
    useAlertStore.setState({ active: [alertOf('a1'), alertOf('a2')] });

    render(<AlertWall open={vi.fn()} />);

    expect(rows()).toHaveLength(2);
  });

  it('holds more than the three the corner could', () => {
    render(<AlertWall open={vi.fn()} />);

    act(() =>
      useAlertStore.setState({
        active: [alertOf('a1'), alertOf('a2'), alertOf('a3'), alertOf('a4'), alertOf('a5')],
      }),
    );

    expect(rows()).toHaveLength(5);
  });

  it('puts the loudest at the top, and the newest of a level above the older', () => {
    render(<AlertWall open={vi.fn()} />);

    act(() =>
      useAlertStore.setState({
        active: [
          alertOf('a1', { severity: 'warn', topic: 'older/warning', firedAt: '2026-09-01T09:00:00Z' }),
          alertOf('a2', { severity: 'warn', topic: 'newer/warning', firedAt: '2026-09-01T09:05:00Z' }),
          alertOf('a3', { severity: 'critical', topic: 'the/critical', firedAt: '2026-09-01T08:00:00Z' }),
        ],
      }),
    );

    expect(rows().map((row) => within(row).getByTestId('alert-wall-topic').textContent)).toEqual([
      'the/critical',
      'newer/warning',
      'older/warning',
    ]);
  });

  it('says the level in words, with the topic, the rule and the reason', () => {
    render(<AlertWall open={vi.fn()} />);

    act(() => useAlertStore.setState({ active: [alertOf('a1')] }));

    const row = screen.getByTestId('alert-wall-row');
    expect(within(row).getByText('critical')).toBeInTheDocument();
    expect(within(row).getByText('sensors/kiln/temp')).toBeInTheDocument();
    expect(within(row).getByText('Kiln too hot')).toBeInTheDocument();
    expect(within(row).getByText('value 91.4 over 90')).toBeInTheDocument();
  });

  // The corner never said this, because a notice was only ever seconds old. A row that has stood
  // all afternoon is a different fact from one that has just gone up.
  it('says what time the alarm fired', () => {
    render(<AlertWall open={vi.fn()} />);

    act(() => useAlertStore.setState({ active: [alertOf('a1', { firedAt: '2026-09-01T09:07:00Z' })] }));

    // The hour is the reader's own, so the shape is what is asserted rather than the number.
    expect(within(screen.getByTestId('alert-wall-row')).getByTestId('alert-wall-clock'))
      .toHaveTextContent(/^\d{2}:\d{2}$/);
  });

  // An alert the engine no longer holds cannot be opened, muted or resolved, so a row standing
  // over one is a phantom alarm. It goes out with the alarm and by no other means.
  it('takes a row away with the alarm it is about', () => {
    render(<AlertWall open={vi.fn()} />);
    act(() => useAlertStore.setState({ active: [alertOf('a1')] }));
    expect(rows()).toHaveLength(1);

    act(() => useAlertStore.setState({ active: [] }));

    expect(rows()).toHaveLength(0);
  });

  describe('and how long a row stays', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    // The corner let a warning go after six seconds, because the corner was interrupting somebody.
    // The wall is not interrupting anybody, so nothing on it is on a timer.
    it('keeps a warning however long it is left', () => {
      render(<AlertWall open={vi.fn()} />);
      act(() => useAlertStore.setState({ active: [alertOf('a1', { severity: 'warn' })] }));

      act(() => vi.advanceTimersByTime(600_000));

      expect(rows()).toHaveLength(1);
    });
  });

  it('stays where it is and says it is quiet when nothing is alarming', () => {
    render(<AlertWall open={vi.fn()} />);

    expect(screen.getByTestId('alert-wall')).toBeInTheDocument();
    expect(screen.getByText('Nothing is alarming.')).toBeInTheDocument();
  });

  // One region that announces what is added to it, rather than a row that re-announces every
  // standing alarm each time the sort puts a new one above it.
  it('is one live region rather than a row of them', () => {
    render(<AlertWall open={vi.fn()} />);
    act(() => useAlertStore.setState({ active: [alertOf('a1')] }));

    const wall = screen.getByTestId('alert-wall');
    expect(wall).toHaveAttribute('role', 'log');
    expect(wall).toHaveAttribute('aria-live', 'polite');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('a row as a way in', () => {
  // Asked of the component rather than of the console, because the wall is off the console for
  // now — see App.test.tsx. What the row owes its caller is this call and nothing else: which
  // panel opens, and what opening one does, are the app's business.
  it('sends the reader to the panel the row is about', async () => {
    const open = vi.fn();
    render(<AlertWall open={open} />);
    act(() => useAlertStore.setState({ active: [alertOf('a1')] }));

    await userEvent.click(screen.getByRole('button', { name: /Open the Kiln too hot alert/ }));

    expect(open).toHaveBeenCalledWith('alerts');
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
    expect(
      menu().getByRole('button', { name: /Alerts, 2 alerting, worst critical/ }),
    ).toBeInTheDocument();
  });

  it('takes four more alarms onto the count', async () => {
    answers([alertOf('a1')]);
    renderApp();
    // Waiting on the badge proves the first snapshot has landed before the four are raised.
    expect(await menu().findByTestId('alert-badge')).toHaveTextContent('1');

    act(() =>
      useAlertStore.getState().raised([alertOf('a2'), alertOf('a3'), alertOf('a4'), alertOf('a5')]),
    );

    expect(menu().getByTestId('alert-badge')).toHaveTextContent('5');
  });

  it('is not there at all when nothing is alarming', async () => {
    renderApp();

    await menu().findByRole('button', { name: 'Alerts' });
    expect(menu().queryByTestId('alert-badge')).not.toBeInTheDocument();
  });

  // On the Settings row, because that is where the switch is. It sat on the Alerts row while the
  // switch did, and a hint that says 'click to turn it on' has to be on the row that opens the
  // panel holding the thing being turned on.
  it('says the sound is wanted but not ready, on the row that can fix it', async () => {
    useAppearanceStore.setState({ alertSound: true });
    renderApp();

    expect(await menu().findByRole('button', { name: 'Settings' })).toHaveAttribute(
      'title',
      'Sound is not ready — click to turn it on',
    );
    expect(menu().getByRole('button', { name: 'Alerts' })).not.toHaveAttribute(
      'title',
      'Sound is not ready — click to turn it on',
    );
  });
});
