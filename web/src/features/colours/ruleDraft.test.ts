import { describe, expect, it } from 'vitest';
import { isFilter } from '../../lib/topicColour';
import { draftFrom, faultIn, newDraftRule, type DraftRule } from './ruleDraft';
import { nextColour, SUGGESTED } from './palette';

const row = (filter: string, colour = '#b45309'): DraftRule => ({ id: 0, filter, colour });

describe('faultIn', () => {
  const faultOf = (filter: string) => faultIn(row(filter), [row(filter)]);

  it.each(['sensors/temp', 'sensors/+/temp', 'sensors/#', '#', '+', 'a//b', 'sensors/+/#'])(
    'passes %s',
    (filter) => {
      expect(faultOf(filter)).toBeNull();
    },
  );

  it('names an empty filter as empty', () => {
    expect(faultOf('')).toMatch(/cannot be empty/i);
  });

  it.each(['a/#/b', '#/a'])('says %s puts # somewhere other than the end', (filter) => {
    expect(faultOf(filter)).toMatch(/last segment/i);
  });

  it.each(['a/b#', 'a/#b'])('says %s does not give # a segment of its own', (filter) => {
    expect(faultOf(filter)).toMatch(/whole segment/i);
  });

  it.each(['a/b+', 'a/+b', 'sport+/x'])('says %s does not give + a segment of its own', (filter) => {
    expect(faultOf(filter)).toMatch(/whole segment/i);
  });

  it('reports the duplicate on the row that was typed, not the one already there', () => {
    const first = row('a/#');
    const second = { ...row('a/#'), id: 1 };

    expect(faultIn(first, [first, second])).toBeNull();
    expect(faultIn(second, [first, second])).toMatch(/already has a colour/i);
  });

  it('lets two rows differing only in case both stand, since topics are case-sensitive', () => {
    const lower = row('a/#');
    const upper = { ...row('A/#'), id: 1 };

    expect(faultIn(upper, [lower, upper])).toBeNull();
  });
});

// Two implementations of the same rule: one says yes or no for the tree, the other explains
// itself for the panel. Kept apart on purpose — pinned together here, because a panel that
// accepted a filter the tree then dropped would be a rule that silently does nothing.
describe('faultIn and isFilter agree on what a filter is', () => {
  const filters = [
    'sensors/temp',
    'sensors/+/temp',
    'sensors/#',
    '#',
    '+',
    'a//b',
    '/leading',
    'trailing/',
    'sensors/+/#',
    '',
    'a/#/b',
    '#/a',
    'a/b#',
    'a/#b',
    'a/b+',
    'a/+b',
    'sport+/x',
    'a/++/b',
    'a/##',
  ];

  it.each(filters)('%s', (filter) => {
    expect(faultIn(row(filter), [row(filter)]) === null).toBe(isFilter(filter));
  });
});

describe('draftFrom', () => {
  it('gives every row an id of its own, so React can key them apart', () => {
    const rows = draftFrom([
      { filter: 'a/#', colour: '#b45309' },
      { filter: 'a/#', colour: '#b45309' },
    ]);

    expect(rows[0].id).not.toBe(rows[1].id);
  });

  it('keeps the order the server sent', () => {
    const rows = draftFrom([
      { filter: 'b/#', colour: '#b45309' },
      { filter: 'a/#', colour: '#ab3520' },
    ]);

    expect(rows.map((r) => r.filter)).toEqual(['b/#', 'a/#']);
  });
});

describe('newDraftRule', () => {
  it('starts with an empty filter, so the row asks to be filled in', () => {
    expect(newDraftRule('#b45309')).toMatchObject({ filter: '', colour: '#b45309' });
  });
});

describe('nextColour', () => {
  it('starts at the head of the palette', () => {
    expect(nextColour([])).toBe(SUGGESTED[0]);
  });

  it('skips what is already in use', () => {
    expect(nextColour([SUGGESTED[0], SUGGESTED[1]])).toBe(SUGGESTED[2]);
  });

  it('ignores the case a colour was written in', () => {
    expect(nextColour([SUGGESTED[0].toUpperCase()])).toBe(SUGGESTED[1]);
  });

  it('fills the gap rather than the end', () => {
    expect(nextColour([SUGGESTED[0], SUGGESTED[2]])).toBe(SUGGESTED[1]);
  });

  // Duplicate colours are allowed — two filters may deliberately share one — so past the
  // palette it just keeps offering something rather than refusing.
  it('carries on once every suggestion is taken', () => {
    expect(SUGGESTED).toContain(nextColour([...SUGGESTED]));
  });
});
