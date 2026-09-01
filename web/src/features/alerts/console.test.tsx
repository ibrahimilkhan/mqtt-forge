import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { createFakeHub } from '../../realtime/fakeHub';
import { server } from '../../test/server';
import { fakeAudio } from '../../test/fakeAudio';
import { useAlertStore } from '../../stores/alertStore';
import { useAppearanceStore } from '../../stores/appearanceStore';
import { useHubStatusStore } from '../../stores/hubStatusStore';
import { useLogStore } from '../../stores/logStore';
import type { AlertDto, AlertRuleDto } from '../../types/api';
import { forgetSound, NOT_READY, TONES } from './alertSound';

/**
 * The alerts console, end to end.
 *
 * Every other test in this feature holds one piece still and asks it a question. This one is the
 * journey: open the panel, write a rule, have the broker set it off, be told, quieten it, and
 * come back from a dropped connection to a console that agrees with the server. Nothing here
 * reaches into a store to arrange the screen — the server answers over MSW and the hub speaks
 * over the fake, because those are the only two ways the real console ever learns anything.
 */

const RULE: AlertRuleDto = {
  id: 'r-heat',
  name: 'Kiln too hot',
  enabled: true,
  filter: 'plant/+/temp',
  field: null,
  condition: { type: 'threshold', op: 'gt', value: 90 },
  clear: null,
  for: 0,
  cooldown: 0,
  severity: 'critical',
  actions: [{ type: 'screen' }],
};

const ALERT: AlertDto = {
  id: 'a-1',
  ruleId: 'r-heat',
  ruleName: 'Kiln too hot',
  topic: 'plant/kiln-2/temp',
  severity: 'critical',
  firedAt: '2026-09-01T09:12:00Z',
  lastSeenAt: '2026-09-01T09:12:04Z',
  resolvedAt: null,
  resolvedBy: null,
  mutedUntil: null,
  count: 3,
  reason: '94.2 over 90',
  value: 94.2,
  sample: '94.2',
  // string[] on the wire, because a delivery that failed is written 'webhook: 404'.
  actions: ['screen'],
};

/**
 * The empty snapshot, which is what a console with nothing wrong reads.
 *
 * `capped` is a list of rules that reached a ceiling — each with the topics it stopped counting —
 * and never a number. The panel reads its length and its `untracked`, and `load()` spreads it: a
 * count here makes `[...snapshot.capped]` throw in every test that mounts `App`, this file's
 * included.
 */
const CALM = {
  active: [] as AlertDto[],
  history: [] as AlertDto[],
  muted: [] as unknown[],
  rules: [] as unknown[],
  warming: [] as unknown[],
  dropped: 0,
  webhooksDropped: 0,
  suppressed: 0,
  capped: [],
  blindSeconds: 0,
};

/**
 * The alerts endpoint, answering from a snapshot the test can change under it.
 *
 * Held in an object rather than closed over, because the resync case is exactly 'the server has
 * moved on since the console last looked'.
 */
function serverHas(active: AlertDto[] = []) {
  const state = { active };

  server.use(
    http.get('/api/alerts', () => HttpResponse.json({ ...CALM, active: state.active })),
  );

  return state;
}

/** The rule list, and what the console tries to write back to it. */
function rulesOn(rules: AlertRuleDto[]) {
  const seen: { rules?: AlertRuleDto[] } = {};

  server.use(
    http.get('/api/alert-rules', () =>
      HttpResponse.json({
        rules,
        allowWebhooks: true,
        topicPrefix: 'mqttforge/alerts/',
        unreadable: false,
        skippedIds: [],
      }),
    ),
    http.put('/api/alert-rules', async ({ request }) => {
      const body = (await request.json()) as { rules: AlertRuleDto[] };
      seen.rules = body.rules;
      return HttpResponse.json({ rules: body.rules, warnings: [] });
    }),
  );

  return seen;
}

function muteTaken() {
  const seen: { body?: { ruleId: string; topic: string; minutes: number } } = {};

  server.use(
    http.post('/api/alerts/mute', async ({ request }) => {
      seen.body = (await request.json()) as typeof seen.body;
      return new HttpResponse(null, { status: 204 });
    }),
  );

  return seen;
}

function renderApp() {
  const hub = createFakeHub();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={queryClient}>
      <App hub={hub} />
    </QueryClientProvider>,
  );

  return hub;
}

const menu = () => within(screen.getByRole('navigation', { name: 'Panels' }));
const railAlerts = () => menu().getByRole('button', { name: /^Alerts/ });
const openPanel = async () => {
  await userEvent.click(railAlerts());
  return within(await screen.findByRole('region', { name: 'Alerts panel' }));
};

const raise = (hub: ReturnType<typeof createFakeHub>, alerts: AlertDto[]) =>
  act(() => hub.emit('alertsRaised', alerts));

beforeEach(() => {
  useLogStore.getState().clear();
  useAppearanceStore.getState().reset();
  forgetSound();
  // Back to the empty snapshot between journeys. Cast, because this writes the store's data half
  // without its actions — setState merges, so the actions are still there afterwards.
  useAlertStore.setState({ ...CALM, syncing: false } as never);
});

afterEach(() => {
  useHubStatusStore.setState({ status: 'live' });
  forgetSound();
  vi.unstubAllGlobals();
});

describe('the alerts console', () => {
  it('opens from the rail, and lists what the server holds', async () => {
    serverHas();
    rulesOn([RULE]);
    renderApp();
    const panel = await openPanel();

    expect(await panel.findByText('Kiln too hot')).toBeInTheDocument();
    expect(panel.getByText('plant/+/temp')).toBeInTheDocument();
  });

  // Rule 2. The list has three writers, and the editor is only one of them: a save that sent its
  // own draft alone would drop every rule the panel already had.
  it('writes a rule in the editor window, and saves the whole list with it', async () => {
    serverHas();
    const seen = rulesOn([RULE]);
    renderApp();
    const panel = await openPanel();

    await userEvent.click(await panel.findByRole('button', { name: 'New rule' }));

    const editor = within(await screen.findByTestId('rule-window'));
    await userEvent.type(editor.getByLabelText('Name'), 'Kiln stopped talking');
    await userEvent.clear(editor.getByLabelText('Topic filter'));
    await userEvent.type(editor.getByLabelText('Topic filter'), 'plant/kiln-2/temp');
    await userEvent.selectOptions(editor.getByLabelText('Condition'), 'threshold');
    await userEvent.type(editor.getByLabelText('Value'), '120');
    await userEvent.click(editor.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(seen.rules).toHaveLength(2));
    expect(seen.rules![0]).toMatchObject({ id: 'r-heat', name: 'Kiln too hot' });
    expect(seen.rules![1]).toMatchObject({
      name: 'Kiln stopped talking',
      filter: 'plant/kiln-2/temp',
      condition: { type: 'threshold', value: 120 },
    });
  });

  // Rule 3 and rule 4 together, and the panel is never opened: this is the console as it stands
  // for most of the day, with the health line off and the rail the only thing on screen.
  it('draws a notice and moves the badge with the panel shut', async () => {
    serverHas();
    rulesOn([RULE]);
    const hub = renderApp();
    await screen.findByRole('navigation', { name: 'Panels' });

    raise(hub, [ALERT]);

    const notice = await within(screen.getByTestId('alert-notices')).findByRole('alert');
    expect(notice).toHaveTextContent('plant/kiln-2/temp');
    expect(notice).toHaveTextContent('Kiln too hot');
    expect(notice).toHaveTextContent('94.2 over 90');
    // Severity in words as well as in colour: the stack is one of the three places this feature
    // can fail silently for somebody.
    expect(notice).toHaveTextContent(/critical/i);

    expect(within(railAlerts()).getByTestId('alert-badge')).toHaveTextContent('1');
    // The badge itself is aria-hidden, so the count has to reach a screen reader through the
    // button's own name. Both, or neither reader is served.
    expect(railAlerts().textContent).toContain('1');
  });

  it('wears no badge while nothing is ringing', async () => {
    serverHas();
    rulesOn([]);
    renderApp();

    await waitFor(() =>
      expect(within(railAlerts()).queryByTestId('alert-badge')).not.toBeInTheDocument(),
    );
  });

  it('quietens a row when it is muted, without touching the rule', async () => {
    serverHas([ALERT]);
    rulesOn([RULE]);
    const seen = muteTaken();
    const hub = renderApp();
    const panel = await openPanel();

    const row = await panel.findByTestId('alert-row');
    await userEvent.click(within(row).getByRole('button', { name: /^Mute/ }));

    await waitFor(() =>
      expect(seen.body).toEqual({
        ruleId: 'r-heat',
        topic: 'plant/kiln-2/temp',
        minutes: 15,
      }),
    );

    // The server says so over the hub, which is the only thing the row believes.
    act(() =>
      // Relative to now, never a written-out instant. A mute is only a mute while it is in the
      // future, and the row asks alertStore's mutedUntil exactly that — so a fixed timestamp is a
      // test that passes in the morning and fails in the afternoon. This one did: it was written
      // as 2026-09-01T09:27:00Z and started failing at 09:27 that day.
      hub.emit(
        'alertMuted',
        'r-heat',
        'plant/kiln-2/temp',
        new Date(Date.now() + 15 * 60_000).toISOString(),
      ),
    );

    await waitFor(() => expect(screen.getByTestId('alert-row')).toHaveAttribute('data-muted', ''));
    expect(
      within(screen.getByTestId('alert-row')).getByRole('button', { name: /^Lift the mute/ }),
    ).toBeInTheDocument();
  });

  // Rule 6. A missed alertsResolved leaves an alarm on screen for ever, and no amount of correct
  // hub handling finds that on its own.
  it('takes away an alert the server no longer has, on a reconnect', async () => {
    const snapshot = serverHas([ALERT]);
    rulesOn([RULE]);
    const hub = renderApp();
    const panel = await openPanel();

    raise(hub, [ALERT]);
    await panel.findByTestId('alert-row');
    expect(within(railAlerts()).getByTestId('alert-badge')).toHaveTextContent('1');

    snapshot.active = [];
    act(() => hub.emit('reconnected'));

    await waitFor(() => expect(screen.queryByTestId('alert-row')).not.toBeInTheDocument());
    // And its notice with it, critical or not. A notice standing over an alert that has gone is
    // the same ghost wearing a different coat: it cannot be opened, muted or resolved, and the
    // panel it leads to does not have it.
    expect(
      within(screen.getByTestId('alert-notices')).queryByRole('alert'),
    ).not.toBeInTheDocument();
    expect(within(railAlerts()).queryByTestId('alert-badge')).not.toBeInTheDocument();
  });

  it('sounds the alert when the reader has turned the sound on', async () => {
    const audio = fakeAudio();
    serverHas();
    rulesOn([RULE]);
    const hub = renderApp();
    const panel = await openPanel();

    await userEvent.click(await panel.findByRole('button', { name: 'Sound off' }));
    raise(hub, [{ ...ALERT, actions: ['screen', 'sound'] }]);

    await waitFor(() => expect(audio.tones).toHaveLength(TONES.critical.beeps));
    expect(audio.tones[0].hz).toBe(TONES.critical.hz);
  });

  // Rule 5, reached the way a reader reaches it: the preference came back from a previous visit,
  // the page has not been clicked, and the alarm arrives anyway.
  it('says the sound is not ready rather than failing quietly', async () => {
    fakeAudio({ suspended: true, refuseResume: true });
    useAppearanceStore.getState().setAlertSound(true);
    serverHas();
    rulesOn([RULE]);
    const hub = renderApp();
    await screen.findByRole('navigation', { name: 'Panels' });

    raise(hub, [{ ...ALERT, actions: ['sound'] }]);

    // With the panel shut, the prompt at the app root is the only thing saying it.
    expect(await screen.findByText(NOT_READY)).toBeInTheDocument();

    const panel = await openPanel();
    expect(panel.getByRole('button', { name: 'Sound waiting' })).toBeInTheDocument();
  });
});
