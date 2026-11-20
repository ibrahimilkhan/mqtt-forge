import { describe, expect, it } from 'vitest';
import { CONDITION_TYPES, faultsIn } from './ruleDraft';
import { TEMPLATE_GROUPS } from './templates';

const WHERE = { topicPrefix: 'mqttforge/alerts/', allowWebhooks: true };
const EVERY = TEMPLATE_GROUPS.flatMap((group) =>
  group.examples.map((example) => [group.type, example.title, group, example] as const),
);

describe('the rule templates', () => {
  it('has one group for every kind of condition, in the editor’s order', () => {
    expect(TEMPLATE_GROUPS.map((group) => group.type)).toEqual([...CONDITION_TYPES]);
  });

  it('gives every group more than one example, each with a title nobody else uses', () => {
    for (const group of TEMPLATE_GROUPS) expect(group.examples.length).toBeGreaterThan(1);

    const titles = EVERY.map(([, title]) => title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it.each(EVERY)('%s: %s is a rule of its own kind', (type, _title, _group, example) => {
    expect(example.draft().condition.type).toBe(type);
  });

  // An example that cannot be saved as it stands is not an example.
  it.each(EVERY)('%s: %s would save as it is', (_type, _title, _group, example) => {
    expect(faultsIn(example.draft(), WHERE)).toEqual({});
  });

  it('gives a fresh copy each time, so two rules from one example share nothing', () => {
    const [first] = TEMPLATE_GROUPS[0].examples;

    expect(first.draft()).not.toBe(first.draft());
    expect(first.draft().condition).not.toBe(first.draft().condition);
  });

  it('covers every operator, method and metric the forms offer', () => {
    const conditions = EVERY.flatMap(([, , , example]) => {
      const { condition } = example.draft();
      return condition.type === 'all' || condition.type === 'any' ? condition.of : [condition];
    });
    const seen = (pick: (c: (typeof conditions)[number]) => string | undefined) =>
      new Set(conditions.map(pick).filter(Boolean));

    expect(seen((c) => (c.type === 'threshold' ? c.op : undefined))).toEqual(
      new Set(['gt', 'lt', 'eq', 'neq']),
    );
    expect(seen((c) => (c.type === 'band' ? String(c.inside) : undefined))).toEqual(
      new Set(['true', 'false']),
    );
    expect(seen((c) => (c.type === 'outlier' ? c.method : undefined))).toEqual(
      new Set(['sigma', 'tukey']),
    );
    expect(seen((c) => (c.type === 'pulse' ? c.metric : undefined))).toEqual(
      new Set(['count', 'duty', 'period', 'width']),
    );
    expect(seen((c) => (c.type === 'pattern' || c.type === 'oneOf' ? String(c.negate) : undefined))).toEqual(
      new Set(['true', 'false']),
    );
  });
});
