import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppearanceStore } from '../../stores/appearanceStore';
import { useLogStore } from '../../stores/logStore';
import { renderWithClient as render } from '../../test/renderWithClient';
import { server } from '../../test/server';
import type {
  AlertDto,
  AlertRuleDto,
  CappedRuleDto,
  RuleDiagnosticDto,
  WarmingPairDto,
} from '../../types/api';
import { useWindows } from '../monitor/useWindows';
import { AlertsPanel } from './AlertsPanel';

const ALERT: AlertDto = {
  id: 'a1',
  ruleId: 'r1',
  ruleName: 'Kiln too hot',
  topic: 'sensors/kiln/temp',
  severity: 'critical',
  // Four minutes ago, worked out from the clock the panel will read, so the assertion below
  // holds in any time zone and on any day.
  firedAt: new Date(Date.now() - 240_000).toISOString(),
  lastSeenAt: new Date().toISOString(),
  resolvedAt: null,
  resolvedBy: null,
  mutedUntil: null,
  count: 12,
  reason: 'value 91.4 over 90',
  value: 91.4,
  sample: '{"c":91.4}',
  // Free text, not the action union: the server writes a delivery that failed as its channel
  // and the reason, so a mark carrying a colon is a mark that did not get through.
  actions: ['screen', 'webhook: 404'],
};

const RULE: AlertRuleDto = {
  id: 'r1',
  name: 'Kiln too hot',
  enabled: true,
  filter: 'sensors/kiln/temp',
  field: 'c',
  condition: { type: 'threshold', op: 'gt', value: 90 },
  clear: null,
  for: 0,
  cooldown: 60,
  severity: 'critical',
  actions: [],
};

const OTHER: AlertRuleDto = { ...RULE, id: 'r2', name: 'Room silent', filter: 'sensors/room/#' };

const SEEING: RuleDiagnosticDto = {
  ruleId: 'r1',
  topics: 3,
  evaluated: 1200,
  skipped: 0,
  lastFiredAt: new Date().toISOString(),
  faulted: false,
  faultReason: null,
};

type Snapshot = {
  active: AlertDto[];
  history: AlertDto[];
  muted: unknown[];
  rules: RuleDiagnosticDto[];
  warming: WarmingPairDto[];
  dropped: number;
  webhooksDropped: number;
  suppressed: number;
  capped: CappedRuleDto[];
  blindSeconds: number;
};

/** What the engine is saying right now. `server.use` prepends, so the last call wins. */
function answers(part: Partial<Snapshot>) {
  const snapshot: Snapshot = {
    active: [],
    history: [],
    muted: [],
    rules: [],
    warming: [],
    dropped: 0,
    webhooksDropped: 0,
    suppressed: 0,
    capped: [],
    blindSeconds: 0,
    ...part,
  };

  server.use(http.get('/api/alerts', () => HttpResponse.json(snapshot)));
}

/** The rules the console holds, which is a different document from the engine's own report. */
function holding(...rules: AlertRuleDto[]) {
  server.use(
    http.get('/api/alert-rules', () =>
      HttpResponse.json({
        rules,
        allowWebhooks: false,
        topicPrefix: 'mqttforge/alerts/',
        unreadable: false,
        skippedIds: [],
      }),
    ),
  );
}

const renderPanel = () => render(<AlertsPanel onClose={vi.fn()} />);

beforeEach(() => {
  useLogStore.getState().clear();
  useWindows.setState({ windows: [] });
  useAppearanceStore.setState({ alertSound: false });
});

describe('AlertsPanel', () => {
  it('says what an active alert is about, and how long it has been up', async () => {
    answers({ active: [ALERT] });
    renderPanel();

    const row = await screen.findByTestId('alert-row');
    expect(within(row).getByText('sensors/kiln/temp')).toBeInTheDocument();
    expect(within(row).getByText('Kiln too hot')).toBeInTheDocument();
    expect(within(row).getByText('value 91.4 over 90')).toBeInTheDocument();
    expect(within(row).getByText('up 4 min')).toBeInTheDocument();
    // The level is a word before it is a colour.
    expect(within(row).getByText('critical')).toBeInTheDocument();
    // A delivery that failed carries its own mark, and it is marked as failed rather than
    // merely written in red.
    expect(within(row).getByText('webhook: 404')).toHaveAttribute('data-failed', '');
    expect(within(row).getByText('screen')).not.toHaveAttribute('data-failed');
  });

  it('mutes the pair the row is about, and the row goes quiet', async () => {
    const sent: unknown[] = [];
    answers({ active: [ALERT] });
    server.use(
      http.post('/api/alerts/mute', async ({ request }) => {
        sent.push(await request.json());
        // The console re-reads the snapshot after a mute; this is what the server now says.
        answers({ active: [{ ...ALERT, mutedUntil: new Date(Date.now() + 900_000).toISOString() }] });
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderPanel();
    await screen.findByTestId('alert-row');

    await userEvent.click(screen.getByRole('button', { name: 'Mute alerts on sensors/kiln/temp' }));

    await waitFor(() =>
      expect(sent).toEqual([{ ruleId: 'r1', topic: 'sensors/kiln/temp', minutes: 15 }]),
    );
    await waitFor(() => expect(screen.getByTestId('alert-row')).toHaveAttribute('data-muted', ''));
    expect(
      screen.getByRole('button', { name: 'Lift the mute on sensors/kiln/temp' }),
    ).toBeInTheDocument();
  });

  it('says what a rule has actually seen', async () => {
    holding(RULE);
    answers({ rules: [SEEING] });
    renderPanel();

    // The time is the reader's own; the shape of the sentence is what is being pinned.
    expect(await screen.findByText(/^3 topics · 1\.2k readings · last fired \d\d:\d\d$/)).toBeInTheDocument();
  });

  it('says so when a rule has matched no topic at all', async () => {
    holding(RULE);
    answers({ rules: [{ ...SEEING, topics: 0, evaluated: 0, lastFiredAt: null }] });
    renderPanel();

    expect(await screen.findByText('matched no topic')).toBeInTheDocument();
  });

  it('says so when every message a rule saw was unreadable', async () => {
    holding(RULE);
    answers({ rules: [{ ...SEEING, evaluated: 400, skipped: 400, lastFiredAt: null }] });
    renderPanel();

    expect(await screen.findByText('no message could be read')).toBeInTheDocument();
  });

  // The guard the sentence above needs: a rule that has seen nothing yet has evaluated === 0
  // and skipped === 0, which are equal, and reading that as 'no message could be read' would
  // accuse a broker that has simply been quiet.
  it('does not accuse a quiet broker of sending unreadable messages', async () => {
    holding(RULE);
    answers({ rules: [{ ...SEEING, evaluated: 0, skipped: 0, lastFiredAt: null }] });
    renderPanel();

    expect(await screen.findByText('3 topics · 0 readings · never fired')).toBeInTheDocument();
    expect(screen.queryByText('no message could be read')).not.toBeInTheDocument();
  });

  it('keeps the engine rows off the panel while every number is nought', async () => {
    answers({});
    renderPanel();

    await screen.findByRole('heading', { name: 'Rules' });
    expect(screen.queryByTestId('engine-row')).not.toBeInTheDocument();
  });

  it('draws an engine row for each number that has moved, and no others', async () => {
    answers({
      dropped: 40,
      webhooksDropped: 2,
      capped: [{ ruleId: 'r1', untracked: 40 }],
      blindSeconds: 12,
    });
    renderPanel();

    await waitFor(() => expect(screen.getAllByTestId('engine-row')).toHaveLength(4));
    expect(screen.getByText(/40 messages went past unjudged/)).toBeInTheDocument();
    expect(screen.getByText(/2 webhook calls were dropped/)).toBeInTheDocument();
    expect(screen.getByText(/1 rule reached a ceiling/)).toBeInTheDocument();
    expect(screen.getByText(/nothing has been judged for 12 s/)).toBeInTheDocument();
  });

  it('names a rule the engine has stopped trusting', async () => {
    holding(RULE);
    answers({ rules: [{ ...SEEING, faulted: true, faultReason: 'the pattern took too long' }] });
    renderPanel();

    expect(await screen.findByText(/Kiln too hot has faulted: the pattern took too long/)).toBeInTheDocument();
  });

  it('says which pairs are still filling their window', async () => {
    answers({
      warming: [{ ruleId: 'r1', topic: 'sensors/kiln/temp', have: 40, need: 200, note: 'outlier' }],
    });
    renderPanel();

    expect(await screen.findByText('sensors/kiln/temp · 40 of 200 readings · outlier')).toBeInTheDocument();
  });

  it('shows what put a past alert out', async () => {
    answers({
      history: [
        {
          ...ALERT,
          id: 'a0',
          resolvedAt: new Date().toISOString(),
          resolvedBy: 'value back under 90',
        },
      ],
    });
    renderPanel();

    const past = await screen.findByTestId('alert-past');
    expect(within(past).getByText(/value back under 90/)).toBeInTheDocument();
  });

  // Rule 2: three writers, one owner. The switch sends the list the cache holds with one rule
  // changed — not the row it happens to be standing on.
  it('sends the whole rule list with only the switched rule flipped', async () => {
    holding(RULE, OTHER);
    answers({});
    const sent: AlertRuleDto[][] = [];
    server.use(
      http.put('/api/alert-rules', async ({ request }) => {
        const body = (await request.json()) as { rules: AlertRuleDto[] };
        sent.push(body.rules);
        return HttpResponse.json({ rules: body.rules, warnings: [] });
      }),
    );
    renderPanel();
    await screen.findByRole('checkbox', { name: 'Turn Kiln too hot off' });

    await userEvent.click(screen.getByRole('checkbox', { name: 'Turn Kiln too hot off' }));

    await waitFor(() => expect(sent[0]).toEqual([{ ...RULE, enabled: false }, OTHER]));
  });

  it('opens a window on the rule being edited, keyed on its draft', async () => {
    holding(RULE);
    answers({});
    renderPanel();
    await screen.findByRole('button', { name: 'Edit Kiln too hot' });

    await userEvent.click(screen.getByRole('button', { name: 'Edit Kiln too hot' }));

    const [window] = useWindows.getState().windows;
    // Task 5's own key for a held rule, so a second Edit on the same rule finds the window it
    // already opened rather than opening a second one beside it.
    expect(window.pane).toEqual({ kind: 'rule', draftId: 'rule:r1' });
  });

  // Rule 5: the preference survives a reload and the armed audio context cannot, so the button
  // has to be able to say that the switch is on and the sound still will not come. The button is
  // Task 7's; that it is on this panel at all is what is being pinned here.
  it('says when the sound is wanted but not ready', async () => {
    useAppearanceStore.setState({ alertSound: true });
    answers({});
    renderPanel();

    expect(await screen.findByRole('button', { name: 'Sound waiting' })).toBeInTheDocument();
  });
});
