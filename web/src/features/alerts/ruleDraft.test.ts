import { beforeEach, describe, expect, it } from 'vitest';
import { useSelectionStore } from '../../stores/selectionStore';
import type { AlertRuleDto } from '../../types/api';
import {
  CONDITION_LABELS,
  CONDITION_SUMMARIES,
  CONDITION_TYPES,
  draftIdOf,
  draftOf,
  forgetDraft,
  readDraft,
  keepDraft,
  retypeCondition,
  ruleOf,
  sameDraft,
  startRuleDraft,
  type DraftCondition,
} from './ruleDraft';
import { useWindows } from '../monitor/useWindows';

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
  actions: [
    { type: 'screen' },
    { type: 'webhook', url: 'https://ops.example/hook', headerNames: ['Authorization'] },
  ],
};

beforeEach(() => {
  useSelectionStore.getState().clear();
  useWindows.setState({ windows: [] });
  forgetDraft('rule:boiler');
});

describe('a draft made from the tree', () => {
  it('takes the topic that is picked as its filter', () => {
    useSelectionStore
      .getState()
      .select({ label: 'sensors/kiln', filter: 'sensors/kiln', topic: 'sensors/kiln' });

    expect(draftOf(undefined, useSelectionStore.getState().selected?.topic).filter).toBe(
      'sensors/kiln',
    );
  });

  it('is empty when what is picked is not a topic at all', () => {
    // The broker row is a connection. There is nothing there for a rule to watch.
    useSelectionStore.getState().select({ label: 'broker', filter: '' });

    expect(draftOf(undefined, useSelectionStore.getState().selected?.topic).filter).toBe('');
  });

  it("leaves an existing rule's own filter alone", () => {
    expect(draftOf(boiler, 'sensors/kiln').filter).toBe('plant/+/temp');
  });
});

describe('a rule taken apart and put back together', () => {
  it("shows a webhook's header names and never a value", () => {
    const draft = draftOf(boiler, undefined);

    expect(draft.webhook?.headers).toEqual([{ name: 'Authorization', value: '', kept: true }]);
  });

  it('sends a header the editor never filled in as an empty value, which the server reads as keep', () => {
    const webhook = ruleOf(draftOf(boiler, undefined)).actions.find((one) => one.type === 'webhook');

    expect(webhook?.headers).toEqual({ Authorization: '' });
  });

  it('keeps a second channel of a kind the form only draws one of', () => {
    const twice: AlertRuleDto = {
      ...boiler,
      actions: [
        { type: 'webhook', url: 'https://one.example', headerNames: [] },
        { type: 'webhook', url: 'https://two.example', headerNames: [] },
      ],
    };

    // Dropped, the second endpoint would stop being told about the alarm and nothing would say so.
    expect(ruleOf(draftOf(twice, undefined)).actions).toHaveLength(2);
  });

  it('keeps a condition this form cannot draw exactly as it stands', () => {
    const nested: AlertRuleDto = {
      ...boiler,
      condition: {
        type: 'all',
        of: [
          { type: 'threshold', op: 'gt', value: 90 },
          { type: 'any', of: [{ type: 'silence', after: 60 }] },
        ],
      },
    };

    expect(ruleOf(draftOf(nested, undefined)).condition).toEqual(nested.condition);
  });

  it('round-trips an absent window as absent, and an absent k as the method default', () => {
    // Nought is how the wire says 'not given'.
    const stats: AlertRuleDto = {
      ...boiler,
      condition: { type: 'outlier', method: 'tukey', k: 0, window: 0 },
    };

    const draft = draftOf(stats, undefined);

    // The window comes back empty; k comes back as the method's own default, because a method
    // with no k is a method at its default and showing it is more use than showing nothing.
    expect(draft.condition).toMatchObject({ k: '1.5', window: '' });
    expect(ruleOf(draft).condition).toEqual({
      type: 'outlier',
      method: 'tukey',
      k: 1.5,
      window: 0,
    });
  });
});

describe('the draft map', () => {
  it('gives one rule one draft however often the editor is asked for', () => {
    startRuleDraft(boiler);
    const first = readDraft(draftIdOf(boiler));
    startRuleDraft(boiler);

    expect(readDraft(draftIdOf(boiler))).toBe(first);
  });

  it('makes the draft again from the rule once it has been forgotten', () => {
    startRuleDraft(boiler);
    forgetDraft('rule:boiler');
    startRuleDraft({ ...boiler, name: 'Boiler, renamed' });

    expect(readDraft('rule:boiler')?.name).toBe('Boiler, renamed');
  });
});

// What the panel asks before it lets a half-written rule go. A draft nobody touched is nothing to
// lose; one that has been typed into is minutes of somebody's work.
describe('telling a touched draft from an untouched one', () => {
  it('sees no change in a draft that was only looked at', () => {
    const draftId = startRuleDraft(boiler);
    const opened = structuredClone(readDraft(draftId)!);

    expect(sameDraft(readDraft(draftId)!, opened)).toBe(true);
  });

  it('sees a change in a draft that has been typed into', () => {
    const draftId = startRuleDraft(boiler);
    const opened = structuredClone(readDraft(draftId)!);

    keepDraft(draftId, { ...readDraft(draftId)!, name: 'Boiler, renamed' });

    expect(sameDraft(readDraft(draftId)!, opened)).toBe(false);
  });

  // The one a field-by-field comparison would have missed: nothing at the top level moved.
  it('sees a change buried in the condition', () => {
    const draftId = startRuleDraft(boiler);
    const opened = structuredClone(readDraft(draftId)!);
    const draft = readDraft(draftId)!;

    keepDraft(draftId, { ...draft, condition: { ...draft.condition, value: '999' } as never });

    expect(sameDraft(readDraft(draftId)!, opened)).toBe(false);
  });
});

/*
 * The picker used to carry the whole sentence in every option — 'Unlike the readings before it',
 * 'The kind of signal has changed' — so choosing between eleven of them meant reading a paragraph,
 * and the closed select afterwards was a line of prose where a name belongs. The sentence moved
 * under the select; what is left in the option is a word.
 */
describe('the words a condition is picked by', () => {
  it('gives every type a name and a sentence, and no type either without the other', () => {
    expect(Object.keys(CONDITION_LABELS).sort()).toEqual([...CONDITION_TYPES].sort());
    expect(Object.keys(CONDITION_SUMMARIES).sort()).toEqual([...CONDITION_TYPES].sort());
  });

  it('keeps every name to a single word', () => {
    for (const type of CONDITION_TYPES) {
      expect(CONDITION_LABELS[type].split(' ')).toHaveLength(1);
    }
  });

  it('opens every sentence with what a reader is comparing, which is when it goes off', () => {
    for (const type of CONDITION_TYPES) {
      expect(CONDITION_SUMMARIES[type]).toMatch(/^Fires /);
    }
  });
});

/*
 * Changing the picker throws the old condition away, which is right nearly every time: a
 * threshold's number and a pulse's number look alike and mean a temperature and a count, and one
 * travelling quietly between them is a rule the reader watches not change on screen.
 *
 * `all` and `any` are the exception, and the only one. They differ in a word — every, or one of —
 * and hold the very same thing.
 */
describe('changing which condition a rule is', () => {
  const three: DraftCondition = {
    type: 'all',
    of: [
      { type: 'threshold', op: 'gt', value: '90' },
      { type: 'pattern', regex: '^ERR', negate: false },
      { type: 'silence', after: '60' },
    ],
  };
  /** The children, for asserting against after `three` has been handed somewhere. */
  const kids = () => (three as { of: DraftCondition[] }).of;

  it('carries the children across an all/any change, in order', () => {
    expect(retypeCondition(three, 'any')).toEqual({ type: 'any', of: kids() });
    expect(retypeCondition({ type: 'any', of: [...kids()] }, 'all')).toEqual({
      type: 'all',
      of: kids(),
    });
  });

  it('carries an empty list too, so nothing about the switch depends on there being work', () => {
    expect(retypeCondition({ type: 'all', of: [] }, 'any')).toEqual({ type: 'any', of: [] });
  });

  it('hands back a blank one for every other change it is asked to make', () => {
    // Away from a composite, into one, and between two simple types that share field names.
    expect(retypeCondition(three, 'threshold')).toEqual({ type: 'threshold', op: 'gt', value: '' });
    expect(retypeCondition({ type: 'threshold', op: 'gt', value: '90' }, 'all')).toEqual({
      type: 'all',
      of: [],
    });
    // A 90 that travelled from a temperature to a count of excursions would look like nothing
    // happened, and would be a different rule.
    expect(retypeCondition({ type: 'threshold', op: 'gt', value: '90' }, 'pulse')).toEqual({
      type: 'pulse',
      metric: 'count',
      op: 'gt',
      value: '',
      window: '',
    });
  });
});
