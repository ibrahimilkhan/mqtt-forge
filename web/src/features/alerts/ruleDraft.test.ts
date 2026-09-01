import { beforeEach, describe, expect, it } from 'vitest';
import { useSelectionStore } from '../../stores/selectionStore';
import type { AlertRuleDto } from '../../types/api';
import { draftIdOf, draftOf, forgetDraft, openRuleEditor, readDraft, ruleOf } from './ruleDraft';
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
    openRuleEditor(boiler);
    const first = readDraft(draftIdOf(boiler));
    openRuleEditor(boiler);

    expect(readDraft(draftIdOf(boiler))).toBe(first);
  });

  it('makes the draft again from the rule once it has been forgotten', () => {
    openRuleEditor(boiler);
    forgetDraft('rule:boiler');
    openRuleEditor({ ...boiler, name: 'Boiler, renamed' });

    expect(readDraft('rule:boiler')?.name).toBe('Boiler, renamed');
  });
});
