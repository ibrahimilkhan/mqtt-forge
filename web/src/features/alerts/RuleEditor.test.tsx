import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderWithClient as render } from '../../test/renderWithClient';
import { server } from '../../test/server';
import { useSelectionStore } from '../../stores/selectionStore';
import type { AlertRuleDto } from '../../types/api';
import { Windows } from '../monitor/Windows';
import { useWindows } from '../monitor/useWindows';
import { forgetDraft, openRuleEditor } from './ruleDraft';

const boiler: AlertRuleDto = {
  id: 'boiler',
  name: 'Boiler temperature',
  enabled: true,
  filter: 'plant/+/temp',
  field: '$.temp',
  condition: { type: 'threshold', op: 'gt', value: 90 },
  clear: null,
  for: 30,
  cooldown: 60,
  severity: 'critical',
  actions: [{ type: 'screen' }],
};

const door: AlertRuleDto = { ...boiler, id: 'door', name: 'Door left open', filter: 'plant/door' };

const kiln = { label: 'sensors/kiln', filter: 'sensors/kiln', topic: 'sensors/kiln' };
const room = { label: 'sensors/room', filter: 'sensors/room', topic: 'sensors/room' };

/** jsdom's viewport is a property like any other, and the window store reads it at open. */
function viewport(width: number) {
  const was = window.innerWidth;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });

  return () => Object.defineProperty(window, 'innerWidth', { configurable: true, value: was });
}

beforeEach(() => {
  useSelectionStore.getState().clear();
  useWindows.setState({ windows: [] });
  forgetDraft('rule:boiler');
  forgetDraft('rule:door');
});

afterEach(() => useWindows.setState({ windows: [] }));

describe('the rule editor window', () => {
  it('brings the window it already has forward rather than opening a second on one draft', async () => {
    render(<Windows />);

    act(() => openRuleEditor(boiler));
    act(() => openRuleEditor(door));
    act(() => openRuleEditor(boiler));

    expect(screen.getAllByTestId('rule-window')).toHaveLength(2);
    // The array IS the z-order, so the one asked for twice is the one on top.
    expect(useWindows.getState().windows.at(-1)?.pane).toEqual({
      kind: 'rule',
      draftId: 'rule:boiler',
    });
  });

  it('opens filling the screen where a window would be narrower than the column it replaces', async () => {
    const back = viewport(600);
    render(<Windows />);

    act(() => openRuleEditor(boiler));

    expect(screen.getByTestId('rule-window')).toHaveAttribute('data-full');
    back();
  });

  it('stands over the rail and the panel column when it fills a narrow screen', async () => {
    const back = viewport(600);
    render(<Windows />);

    act(() => openRuleEditor(boiler));

    // At this width the rail lying over the workspace climbs to 300 and throws a scrim across the
    // whole viewport. A form under that scrim cannot be read, let alone filled in — and a window
    // nobody can see is the same as no window at all.
    expect(Number(screen.getByTestId('rule-window').style.zIndex)).toBeGreaterThan(300);
    back();
  });

  it('puts a window opened full back to the size a window opens at', async () => {
    const back = viewport(600);
    render(<Windows />);
    act(() => openRuleEditor(boiler));

    await userEvent.click(
      screen.getByRole('button', { name: 'Put Boiler temperature editor back' }),
    );

    expect(screen.getByTestId('rule-window')).not.toHaveAttribute('data-full');
    expect(screen.getByTestId('rule-window').style.width).not.toBe(`${window.innerWidth}px`);
    back();
  });

  it('takes the picked topic as the filter of a new rule, once, at the moment it opens', async () => {
    act(() => useSelectionStore.getState().select(kiln));
    render(<Windows />);

    act(() => openRuleEditor());

    expect(screen.getByLabelText('Topic filter')).toHaveValue('sensors/kiln');

    // Clicking about the tree with a window open must not rewrite the form under the reader.
    act(() => useSelectionStore.getState().select(room));

    expect(screen.getByLabelText('Topic filter')).toHaveValue('sensors/kiln');
  });

  it('never prefills a rule that already exists', async () => {
    act(() => useSelectionStore.getState().select(kiln));
    render(<Windows />);

    act(() => openRuleEditor(boiler));

    expect(screen.getByLabelText('Topic filter')).toHaveValue('plant/+/temp');
    expect(screen.getByLabelText('Name')).toHaveValue('Boiler temperature');
    expect(screen.getByLabelText('For, seconds')).toHaveValue('30');
  });

  it('keeps what has been typed when the window is closed', async () => {
    render(<Windows />);
    act(() => openRuleEditor(boiler));

    await userEvent.clear(screen.getByLabelText('Name'));
    await userEvent.type(screen.getByLabelText('Name'), 'Kiln temperature');
    await userEvent.click(
      screen.getByRole('button', { name: 'Close the Boiler temperature editor' }),
    );

    expect(screen.queryByTestId('rule-window')).not.toBeInTheDocument();

    act(() => openRuleEditor(boiler));

    expect(screen.getByLabelText('Name')).toHaveValue('Kiln temperature');
  });

  it('gives two editors open at once fields of their own', async () => {
    render(<Windows />);

    act(() => openRuleEditor(boiler));
    act(() => openRuleEditor(door));

    // One id on two boxes would point every label in the second window at the first window's
    // field, and a click on a label would put the focus in the wrong window entirely.
    const names = screen.getAllByLabelText('Name');
    expect(names).toHaveLength(2);
    expect(names[0].id).not.toBe(names[1].id);
  });
});

/**
 * The API, holding a rule set. Answers the GET with what it holds, and a PUT replaces it — which
 * is what makes 'two editors, neither losing the other's change' a test of the console rather than
 * of a stub that always says yes.
 */
function api(...rules: AlertRuleDto[]) {
  const held = { rules: [...rules], sent: [] as AlertRuleDto[][] };

  server.use(
    http.get('/api/alert-rules', () =>
      HttpResponse.json({
        rules: held.rules,
        allowWebhooks: true,
        topicPrefix: 'mqttforge/alerts/',
        unreadable: false,
        skippedIds: [],
      }),
    ),
    http.put('/api/alert-rules', async ({ request }) => {
      const body = (await request.json()) as { rules: AlertRuleDto[] };
      held.sent.push(body.rules);
      // Ids handed out the way the server hands them out, so a second save of a new rule updates
      // it rather than appending it again.
      held.rules = body.rules.map((rule, index) => ({ ...rule, id: rule.id ?? `given-${index}` }));

      return HttpResponse.json({ rules: held.rules, warnings: [] });
    }),
  );

  return held;
}

const save = () => screen.getByRole('button', { name: 'Save' });

describe('saving a rule', () => {
  it('keeps a header whose value it was never shown', async () => {
    const held = api({
      ...boiler,
      actions: [
        { type: 'screen' },
        { type: 'webhook', url: 'https://ops.example/hook', headerNames: ['Authorization'] },
      ],
    });
    render(<Windows />);
    act(() => openRuleEditor(held.rules[0]));

    await userEvent.clear(screen.getByLabelText('Name'));
    await userEvent.type(screen.getByLabelText('Name'), 'Boiler, renamed');
    await userEvent.click(save());

    await waitFor(() => expect(held.sent).toHaveLength(1));
    const webhook = held.sent[0][0].actions.find((one) => one.type === 'webhook');
    // The name, with an empty value: the sentence the server reads as 'the one you already have'.
    expect(webhook?.headers).toEqual({ Authorization: '' });
  });

  it('says on screen that an empty value keeps the stored one', async () => {
    const held = api({
      ...boiler,
      actions: [
        { type: 'webhook', url: 'https://ops.example/hook', headerNames: ['Authorization'] },
      ],
    });
    render(<Windows />);
    // The rule WITH the webhook on it: the sentence lives under the header rows, and a rule with
    // no webhook draws neither.
    act(() => openRuleEditor(held.rules[0]));

    expect(screen.getByText(/leave it empty to keep/i)).toBeInTheDocument();
  });

  it('lets two editors each save without undoing the other', async () => {
    const held = api(boiler, door);
    render(<Windows />);
    act(() => openRuleEditor(boiler));
    act(() => openRuleEditor(door));

    const [boilerName, doorName] = screen.getAllByLabelText('Name');
    await userEvent.clear(doorName);
    await userEvent.type(doorName, 'Door, renamed');
    await userEvent.click(screen.getAllByRole('button', { name: 'Save' })[1]);
    await waitFor(() => expect(held.rules[1].name).toBe('Door, renamed'));

    await userEvent.clear(boilerName);
    await userEvent.type(boilerName, 'Boiler, renamed');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(held.rules[0].name).toBe('Boiler, renamed'));
    // The body is compiled at the click from the cache, so the second save carried the first.
    expect(held.rules[1].name).toBe('Door, renamed');
  });

  it('adds a new rule to the ones already stored rather than replacing them', async () => {
    const held = api(boiler);
    render(<Windows />);
    act(() => openRuleEditor());

    await userEvent.type(screen.getByLabelText('Name'), 'Kiln temperature');
    await userEvent.type(screen.getByLabelText('Topic filter'), 'sensors/kiln');
    await userEvent.type(screen.getByLabelText('Value'), '900');
    await userEvent.click(save());

    await waitFor(() => expect(held.rules).toHaveLength(2));
    expect(held.rules.map((rule) => rule.name)).toEqual(['Boiler temperature', 'Kiln temperature']);
  });

  it('shuts the window and forgets the draft once the server has it', async () => {
    api(boiler);
    render(<Windows />);
    act(() => openRuleEditor(boiler));

    await userEvent.clear(screen.getByLabelText('Name'));
    await userEvent.type(screen.getByLabelText('Name'), 'Boiler, renamed');
    await userEvent.click(save());

    await waitFor(() => expect(screen.queryByTestId('rule-window')).not.toBeInTheDocument());
  });
});

describe('what the editor refuses before the request', () => {
  it('refuses a window below the range the engine judges anything on', async () => {
    const held = api(boiler);
    render(<Windows />);
    act(() => openRuleEditor(boiler));

    await userEvent.selectOptions(screen.getByLabelText('Condition'), 'distributionShift');
    await userEvent.type(screen.getByLabelText('Readings in the window'), '10');

    expect(screen.getByText(/between 20 and 2000 readings/i)).toBeInTheDocument();
    expect(save()).toBeDisabled();
    // Not a 400 after the fact: the answer is on screen while the number is still under the hand.
    expect(held.sent).toHaveLength(0);
  });

  it('refuses a k outside the range the chosen method means', async () => {
    api(boiler);
    render(<Windows />);
    act(() => openRuleEditor(boiler));

    await userEvent.selectOptions(screen.getByLabelText('Condition'), 'outlier');
    await userEvent.selectOptions(screen.getByLabelText('Method'), 'sigma');
    await userEvent.clear(screen.getByLabelText('k'));
    await userEvent.type(screen.getByLabelText('k'), '40');

    expect(screen.getByText(/number of deviations, from 1 to 10/i)).toBeInTheDocument();
    expect(save()).toBeDisabled();
  });

  it('refuses a rule with no name, and says which field it means', async () => {
    api(boiler);
    render(<Windows />);
    act(() => openRuleEditor(boiler));

    await userEvent.clear(screen.getByLabelText('Name'));

    expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true');
    expect(save()).toBeDisabled();
  });

  it('refuses a publish topic outside the tree this server publishes into', async () => {
    api(boiler);
    render(<Windows />);
    act(() => openRuleEditor(boiler));

    await userEvent.click(screen.getByLabelText('Publish'));
    await userEvent.type(screen.getByLabelText('Publish topic'), 'plant/boiler/alarm');

    expect(screen.getByText(/mqttforge\/alerts\//)).toBeInTheDocument();
    expect(save()).toBeDisabled();
  });
});
