import { describe, expect, it } from 'vitest';
import type { AlertCondition, AlertRuleDto } from '../../types/api';
import { firesOn } from './ruleSummary';

const rule = (condition: AlertCondition, field: string | null = '$.c'): AlertRuleDto => ({
  id: 'r1',
  name: 'A rule',
  enabled: true,
  filter: 'plant/+/temp',
  field,
  condition,
  clear: null,
  for: 0,
  cooldown: 0,
  severity: 'warn',
  actions: [],
});

/**
 * One line saying what sets a rule off, for the column in the rules table.
 *
 * The panel used to say nothing at all about this: a rule was a name and a topic filter, and the
 * only way to tell two of them apart was to open both. The line has to fit a table cell, so it is
 * the shortest true sentence rather than the whole condition — the editor is where the whole
 * condition lives.
 */
describe('what fires a rule, in one line', () => {
  it('reads a threshold as the comparison it is', () => {
    expect(firesOn(rule({ type: 'threshold', op: 'gt', value: 90 }))).toBe('$.c > 90');
  });

  // Every operator, because a rule that fires on 'at most 90' reading as 'over 90' is the worst
  // kind of wrong: it is legible, and it is the opposite of the truth.
  it('says each operator as its own sign', () => {
    const signs = (['gt', 'gte', 'lt', 'lte', 'eq', 'neq'] as const).map(
      (op) => firesOn(rule({ type: 'threshold', op, value: 1 })),
    );

    expect(signs).toEqual(['$.c > 1', '$.c ≥ 1', '$.c < 1', '$.c ≤ 1', '$.c = 1', '$.c ≠ 1']);
  });

  // A rule with no field reads the whole payload as the number.
  it('says "value" where the rule names no field', () => {
    expect(firesOn(rule({ type: 'threshold', op: 'lt', value: 4 }, null))).toBe('value < 4');
  });

  it('says which side of a band it wants', () => {
    expect(firesOn(rule({ type: 'band', low: 1, high: 10, inside: true }))).toBe('$.c inside 1–10');
    expect(firesOn(rule({ type: 'band', low: 1, high: 10, inside: false }))).toBe(
      '$.c outside 1–10',
    );
  });

  it('reads a silence as the wait it is', () => {
    expect(firesOn(rule({ type: 'silence', after: 600 }))).toBe('silent for 10 min');
  });

  it('names the method a run is judged by', () => {
    expect(firesOn(rule({ type: 'outlier', method: 'tukey', k: 1.5 }))).toBe('outlier · tukey 1.5');
    expect(firesOn(rule({ type: 'outlier', method: 'sigma' }))).toBe('outlier · sigma');
  });

  it('says the two that are moments rather than comparisons', () => {
    expect(firesOn(rule({ type: 'distributionShift' }))).toBe('distribution shifts');
    expect(firesOn(rule({ type: 'shapeChange' }))).toBe('shape changes');
  });

  it('reads a pulse as the measurement it compares', () => {
    expect(firesOn(rule({ type: 'pulse', metric: 'period', op: 'gt', value: 5 }))).toBe(
      'period > 5',
    );
  });

  it('says what a pattern is looking for, and whether it wants a miss', () => {
    expect(firesOn(rule({ type: 'pattern', regex: 'ERR', negate: false }))).toBe('matches ERR');
    expect(firesOn(rule({ type: 'pattern', regex: 'ERR', negate: true }))).toBe(
      'does not match ERR',
    );
  });

  it('counts a list rather than reciting it', () => {
    expect(firesOn(rule({ type: 'oneOf', values: ['a', 'b', 'c'], negate: false }))).toBe(
      'one of 3 values',
    );
    expect(firesOn(rule({ type: 'oneOf', values: ['a'], negate: true }))).toBe('none of 1 value');
  });

  // A tree is the one shape that cannot be said in a cell. It says how many branches it has, and
  // the reader opens it to see them.
  it('says how many parts a tree has rather than trying to read it out', () => {
    const leaf: AlertCondition = { type: 'threshold', op: 'gt', value: 1 };

    expect(firesOn(rule({ type: 'all', of: [leaf, leaf] }))).toBe('all of 2 conditions');
    expect(firesOn(rule({ type: 'any', of: [leaf, leaf, leaf] }))).toBe('any of 3 conditions');
  });
});
