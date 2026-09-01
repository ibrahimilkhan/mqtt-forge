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
  // 'Alerting now' stood at the top: every standing alarm, how long it had been up, and the
  // control that muted the pair. The panel is the rules now and nothing else — what is alarming
  // is the rail's count, and this list is what is being watched for rather than what is wrong.
  //
  // Muting went out with the row it lived on: it was reachable from nowhere else. The state and
  // the hub event behind it are untouched and still covered in alertStore.test.ts.
  it('lists no standing alarms, whatever the engine is holding', async () => {
    holding(RULE);
    answers({ active: [ALERT] });
    renderPanel();

    await screen.findByTestId('alert-rule');
    expect(screen.queryByText('Alerting now')).not.toBeInTheDocument();
    expect(screen.queryByTestId('alert-row')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Mute/ })).not.toBeInTheDocument();
  });

  // The editor was a window floating over the console. It is the panel now, in place of the list:
  // writing a rule is what this panel is for while it is happening.
  it('writes a new rule in the panel itself rather than in a window of its own', async () => {
    holding(RULE);
    answers({});
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'New rule' }));

    expect(screen.getByLabelText('Name')).toBeInTheDocument();
    expect(screen.queryByTestId('alert-rule')).not.toBeInTheDocument();
    expect(screen.queryByTestId('rule-window')).not.toBeInTheDocument();
  });

  it('goes straight back from a rule nobody typed into', async () => {
    holding(RULE);
    answers({});
    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Kiln too hot' }));

    await userEvent.click(screen.getByRole('button', { name: '← Back' }));

    expect(await screen.findByTestId('alert-rule')).toBeInTheDocument();
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
  });

  // The only thing standing between minutes of somebody's work and a mis-aimed click on Back.
  it('asks before throwing away a rule that has been filled in', async () => {
    holding(RULE);
    answers({});
    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'New rule' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Kiln stopped talking');

    await userEvent.click(screen.getByRole('button', { name: '← Back' }));

    // Still on the form: nothing has been thrown away yet, and the form is what is being asked
    // about, so it stays on screen under the question.
    expect(screen.getByRole('alertdialog', { name: 'Leave without saving?' })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Kiln stopped talking');

    await userEvent.click(screen.getByRole('button', { name: 'Keep writing' }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Kiln stopped talking');
  });

  // There were two ways out: the panel's Back, which asks, and a Close inside the form, which
  // called the same 'forget it and go back' without asking. The friendlier-sounding word was the
  // one that threw work away.
  it('offers one way out of a filled-in rule, and it is the one that asks', async () => {
    holding(RULE);
    answers({});
    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'New rule' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Kiln stopped talking');

    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '← Back' }));

    const asked = screen.getByRole('alertdialog', { name: 'Leave without saving?' });
    expect(asked).toBeInTheDocument();

    // Under the form, not over it. The question is about a press the reader has just made on the
    // form's last row, and an answer that appeared above the first column would be an answer
    // somewhere else on the screen.
    const form = document.querySelector('form')!;
    expect(form.compareDocumentPosition(asked) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  /*
   * 'New rule' stood under the table, in a row of its own, which is where a form's Save goes —
   * the end of a thing being filled in. This list is not being filled in, and on an empty panel
   * the button was a control stranded under a sentence saying there was nothing here.
   */
  it('offers the new rule at the end of the line the section is named on', async () => {
    holding(RULE);
    renderPanel();

    const make = await screen.findByRole('button', { name: 'New rule' });
    const heading = screen.getByRole('heading', { name: 'Rules' });

    expect(make.parentElement).toBe(heading.parentElement);
    // The name reads first; the button is at the other end of the row.
    expect(heading.compareDocumentPosition(make) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // And the mark inside it is a mark, not part of the name a listener hears.
    expect(make.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('lets the rule go once the reader has said so twice', async () => {
    holding(RULE);
    answers({});
    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'New rule' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Kiln stopped talking');

    await userEvent.click(screen.getByRole('button', { name: '← Back' }));
    await userEvent.click(screen.getByRole('button', { name: 'Discard it' }));

    expect(await screen.findByTestId('alert-rule')).toBeInTheDocument();

    // And it is gone rather than parked: opening a new rule again starts from nothing.
    await userEvent.click(screen.getByRole('button', { name: 'New rule' }));
    expect(screen.getByLabelText('Name')).toHaveValue('');
  });

  // The console's one rule about Escape is that it shuts the thing in front of you, and it must
  // not become the one gesture that can lose work.
  it('treats Escape as Back, question and all', async () => {
    holding(RULE);
    answers({});
    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'New rule' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Kiln stopped talking');

    await userEvent.keyboard('{Escape}');

    expect(screen.getByRole('alertdialog', { name: 'Leave without saving?' })).toBeInTheDocument();
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

    await waitFor(() => expect(screen.getAllByTestId('engine-row')).toHaveLength(3));
    expect(screen.getByText(/40 messages went past unjudged/)).toBeInTheDocument();
    expect(screen.getByText(/2 webhook calls were dropped/)).toBeInTheDocument();
    expect(screen.getByText(/1 rule reached a ceiling/)).toBeInTheDocument();
  });

  // The one number here that was never about the engine: being blind is being disconnected, and
  // the rail says whether there is a link on every screen the console has. Two places saying one
  // thing is two wordings to keep in step, and this was the one nobody could read.
  it('says nothing about being blind, however long the link has been down', async () => {
    answers({ blindSeconds: 31 });
    renderPanel();

    await screen.findByRole('heading', { name: 'Rules' });
    expect(screen.queryByText(/nothing has been judged/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Blind/)).not.toBeInTheDocument();
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

  it('keeps no log of the alarms that have already gone out', async () => {
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

    // The panel is what is alarming now and the rules behind it. A log of what has already gone
    // out was a third thing on the same page, growing forever and answering nothing a reader
    // opens this panel to ask. The store still holds it — see alertStore — and nothing draws it.
    expect(await screen.findByText(/No alert rules yet/)).toBeInTheDocument();
    expect(screen.queryByTestId('alert-past')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear history' })).not.toBeInTheDocument();
  });

  // Numbered so a rule can be pointed at in a sentence — 'rule 3 is the one that never fires' —
  // and in the order the file holds them, which is the order they were written in. Not by name:
  // a list that reorders itself when a rule is renamed is a list whose numbers mean nothing.
  it('numbers the rules in the order they are saved in', async () => {
    holding(OTHER, RULE);
    answers({});
    renderPanel();

    const listed = await screen.findAllByTestId('alert-rule');
    expect(within(listed[0]).getByTestId('rule-number')).toHaveTextContent('1');
    expect(within(listed[0]).getByText('Room silent')).toBeInTheDocument();
    expect(within(listed[1]).getByTestId('rule-number')).toHaveTextContent('2');
    expect(within(listed[1]).getByText('Kiln too hot')).toBeInTheDocument();
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

  it('edits the rule the row is about, prefilled from the rule itself', async () => {
    holding(RULE);
    answers({});
    renderPanel();
    await screen.findByRole('button', { name: 'Edit Kiln too hot' });

    await userEvent.click(screen.getByRole('button', { name: 'Edit Kiln too hot' }));

    expect(screen.getByLabelText('Name')).toHaveValue('Kiln too hot');
    expect(screen.getByLabelText('Topic filter')).toHaveValue('sensors/kiln/temp');
  });

  // The switch moved to Settings, where the rest of 'what this machine does' lives. It is not a
  // control about alerting: a rule says whether it wants a tone, and the switch says whether this
  // browser will make one. See AppearancePanel.test.tsx, which now pins it.
  it('leaves the sound switch to the settings panel', async () => {
    useAppearanceStore.setState({ alertSound: true });
    answers({});
    renderPanel();

    expect(await screen.findByText(/No alert rules yet/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Sound/ })).not.toBeInTheDocument();
  });
});
