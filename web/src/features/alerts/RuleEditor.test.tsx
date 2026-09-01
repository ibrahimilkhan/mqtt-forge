import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderWithClient as render } from '../../test/renderWithClient';
import { server } from '../../test/server';
import { useSelectionStore } from '../../stores/selectionStore';
import type { AlertRuleDto } from '../../types/api';
import { RuleEditor } from './RuleEditor';
import { forgetDraft, startRuleDraft } from './ruleDraft';

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

/** A rule whose condition is a tree, for the one change that must not flatten it. */
const tree: AlertRuleDto = {
  ...boiler,
  id: 'tree',
  name: 'Hot and the pump is off',
  condition: {
    type: 'all',
    of: [
      { type: 'threshold', op: 'gt', value: 90 },
      { type: 'pattern', regex: '^OFF$', negate: false },
    ],
  },
};

const kiln = { label: 'sensors/kiln', filter: 'sensors/kiln', topic: 'sensors/kiln' };
const room = { label: 'sensors/room', filter: 'sensors/room', topic: 'sensors/room' };

/**
 * The editor, on a draft of the given rule.
 *
 * It is mounted directly rather than through the alerts panel that draws it: everything below is
 * about the form — what it is prefilled with, what it refuses, and what it sends — and the panel's
 * own part, which is where the editor appears and what leaving it costs, is pinned in
 * AlertsPanel.test.tsx where it belongs.
 */
function openEditor(rule?: AlertRuleDto) {
  const draftId = startRuleDraft(rule);

  return {
    draftId,
    done,
    ...render(
      <RuleEditor draftId={draftId} onDone={() => (done += 1)} onBack={() => (went += 1)} />,
    ),
  };
}

/** How many times the editor has said it is finished. */
let done = 0;
/** How many times it has been asked to go back. The panel owns what that costs; this counts it. */
let went = 0;

beforeEach(() => {
  useSelectionStore.getState().clear();
  done = 0;
  went = 0;
  forgetDraft('rule:boiler');
  forgetDraft('rule:door');
  forgetDraft('rule:tree');
});

describe('the rule editor', () => {
  // The corner stack faded a warning after six seconds and held a critical until somebody
  // dismissed it, and the note under the level said so. Nothing fades or is dismissed any more:
  // a standing alarm stands whatever its level, and what the level decides is where in the
  // Alerts panel it stands.
  it('says what the level decides, which is no longer how long anything survives', async () => {
    openEditor(boiler);

    expect(
      screen.getByText('A critical alarm stands at the top of the Alerts panel while it is alarming.'),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('radio', { name: 'warn' }));

    expect(
      screen.getByText('An info or warn alarm stands below the criticals while it is alarming.'),
    ).toBeInTheDocument();
  });

  it('takes the picked topic as the filter of a new rule, once, at the moment it opens', async () => {
    act(() => useSelectionStore.getState().select(kiln));
    openEditor();

    expect(screen.getByLabelText('Topic filter')).toHaveValue('sensors/kiln');

    // Clicking about the tree with a window open must not rewrite the form under the reader.
    act(() => useSelectionStore.getState().select(room));

    expect(screen.getByLabelText('Topic filter')).toHaveValue('sensors/kiln');
  });

  it('never prefills a rule that already exists', async () => {
    act(() => useSelectionStore.getState().select(kiln));
    openEditor(boiler);

    expect(screen.getByLabelText('Topic filter')).toHaveValue('plant/+/temp');
    expect(screen.getByLabelText('Name')).toHaveValue('Boiler temperature');
    expect(screen.getByLabelText('For, seconds')).toHaveValue('30');
  });
});

/**
 * The API, holding a rule set. Answers the GET with what it holds, and a PUT replaces it — which
 * is what makes 'a save carries the list the cache holds' a test of the console rather than of a
 * stub that always says yes.
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

  /*
   * The button row is not one of the columns, and that is load bearing.
   *
   * The three sections are laid out with `auto-fit`, which fits as many tracks as the width
   * allows and then collapses the ones nothing landed in. A footer spanning `1 / -1` lands in all
   * of them — so the empty ones stayed open, and the panel drew four tracks at 1400px with the
   * sections in three of them and 326 pixels of nothing against the right-hand edge. At 2560 it
   * was eight tracks and five of them empty.
   */
  it('keeps the button row out of the grid the three sections are laid out in', () => {
    openEditor(boiler);

    const parts = [...document.querySelectorAll('fieldset')];
    const footer = screen.getByRole('button', { name: 'Save' }).parentElement!;

    expect(parts).toHaveLength(3);
    // One parent for all three, and it is not the footer's.
    expect(new Set(parts.map((one) => one.parentElement))).toHaveProperty('size', 1);
    expect(footer.parentElement).not.toBe(parts[0].parentElement);
  });

  /*
   * 'all' and 'any' are the same list joined differently, and the picker used to empty it on the
   * way between them. Somebody writes three children under 'all', reads the rule back, decides
   * they meant 'any' — and the three children are gone. A first choice being wrong and put right
   * afterwards is how a rule gets written; it is not a reason to lose the writing.
   */
  it('keeps the conditions already written when the join changes from all to any', async () => {
    openEditor(tree);

    expect(screen.getByLabelText('Condition 1')).toHaveValue('threshold');
    expect(screen.getByLabelText('Condition 2')).toHaveValue('pattern');
    expect(screen.getByLabelText('Expression')).toHaveValue('^OFF$');

    await userEvent.selectOptions(screen.getByLabelText('Condition'), 'any');

    expect(screen.getByLabelText('Condition')).toHaveValue('any');
    expect(screen.getByLabelText('Condition 1')).toHaveValue('threshold');
    expect(screen.getByLabelText('Condition 2')).toHaveValue('pattern');
    // The values inside the children, not merely the right number of empty ones.
    expect(screen.getByLabelText('Expression')).toHaveValue('^OFF$');
  });

  // The other half of the same rule: everything else still starts from nothing, because a
  // threshold's number and a pulse's number are a temperature and a count of excursions.
  it('starts a different kind of condition from blank', async () => {
    openEditor(boiler);

    expect(screen.getByLabelText('Value')).toHaveValue('90');

    await userEvent.selectOptions(screen.getByLabelText('Condition'), 'pulse');

    expect(screen.getByLabelText('Value')).toHaveValue('');
  });

  // Back stood at the top of the panel, above the heading of the first column, which is where a
  // browser puts a back button and the wrong place for this one: it is not navigation, it is the
  // other answer to the question Save asks.
  it('offers the way out on the same row as the way in, and leaves what it costs to the panel', async () => {
    openEditor(boiler);

    const back = screen.getByRole('button', { name: '← Back' });

    expect(back.parentElement).toBe(save().parentElement);
    // Back reads first; Save is held to the right-hand end of the row.
    expect(back.compareDocumentPosition(save()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await userEvent.click(back);

    // The editor knows nothing about drafts being abandoned — the panel asks that question.
    expect(went).toBe(1);
    expect(done).toBe(0);
  });

describe('saving a rule', () => {
  it('keeps a header whose value it was never shown', async () => {
    const held = api({
      ...boiler,
      actions: [
        { type: 'screen' },
        { type: 'webhook', url: 'https://ops.example/hook', headerNames: ['Authorization'] },
      ],
    });
    openEditor(held.rules[0]);

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
    // The rule WITH the webhook on it: the sentence lives under the header rows, and a rule with
    // no webhook draws neither.
    openEditor(held.rules[0]);

    expect(screen.getByText(/leave it empty to keep/i)).toBeInTheDocument();
  });

  it('adds a new rule to the ones already stored rather than replacing them', async () => {
    const held = api(boiler);
    openEditor();

    await userEvent.type(screen.getByLabelText('Name'), 'Kiln temperature');
    await userEvent.type(screen.getByLabelText('Topic filter'), 'sensors/kiln');
    await userEvent.type(screen.getByLabelText('Value'), '900');
    await userEvent.click(save());

    await waitFor(() => expect(held.rules).toHaveLength(2));
    expect(held.rules.map((rule) => rule.name)).toEqual(['Boiler temperature', 'Kiln temperature']);
  });

  it('says it is finished once the server has the rule', async () => {
    api(boiler);
    openEditor(boiler);

    await userEvent.clear(screen.getByLabelText('Name'));
    await userEvent.type(screen.getByLabelText('Name'), 'Boiler, renamed');
    await userEvent.click(save());

    // Which is what sends the panel back to its list, and what forgets the draft.
    await waitFor(() => expect(done).toBe(1));
  });
});

describe('what the editor refuses before the request', () => {
  it('refuses a window below the range the engine judges anything on', async () => {
    const held = api(boiler);
    openEditor(boiler);

    await userEvent.selectOptions(screen.getByLabelText('Condition'), 'distributionShift');
    await userEvent.type(screen.getByLabelText('Readings in the window'), '10');

    expect(screen.getByText(/between 20 and 2000 readings/i)).toBeInTheDocument();
    expect(save()).toBeDisabled();
    // Not a 400 after the fact: the answer is on screen while the number is still under the hand.
    expect(held.sent).toHaveLength(0);
  });

  it('refuses a k outside the range the chosen method means', async () => {
    api(boiler);
    openEditor(boiler);

    await userEvent.selectOptions(screen.getByLabelText('Condition'), 'outlier');
    await userEvent.selectOptions(screen.getByLabelText('Method'), 'sigma');
    await userEvent.clear(screen.getByLabelText('k'));
    await userEvent.type(screen.getByLabelText('k'), '40');

    expect(screen.getByText(/number of deviations, from 1 to 10/i)).toBeInTheDocument();
    expect(save()).toBeDisabled();
  });

  it('refuses a rule with no name, and says which field it means', async () => {
    api(boiler);
    openEditor(boiler);

    await userEvent.clear(screen.getByLabelText('Name'));

    expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true');
    expect(save()).toBeDisabled();
  });

  it('refuses a publish topic outside the tree this server publishes into', async () => {
    api(boiler);
    openEditor(boiler);

    await userEvent.click(screen.getByLabelText('Publish'));
    await userEvent.type(screen.getByLabelText('Publish topic'), 'plant/boiler/alarm');

    expect(screen.getByText(/mqttforge\/alerts\//)).toBeInTheDocument();
    expect(save()).toBeDisabled();
  });
});
