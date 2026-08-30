import { describe, expect, it } from 'vitest';
import { above, branchesUnder, clip, MOST_CHARS, named } from './fieldTree';

const fields = [
  'uptime',
  'broker.port',
  'broker.session.clean',
  'broker.session.expiryInterval',
  'radios.0.dbm',
  'radios.1.dbm',
];

describe('branchesUnder', () => {
  it('answers the top of a body with its own first segments, once each', () => {
    expect(branchesUnder(fields, '').map((branch) => branch.segment)).toEqual([
      'uptime',
      'broker',
      'radios',
    ]);
  });

  // The ranking is the whole reason `numericFields` bothers to count: the field most messages
  // carry is both the likeliest one wanted and the one whose chart has the fewest gaps.
  it('keeps the order the fields came in', () => {
    expect(branchesUnder(['b.x', 'a.y', 'b.z'], '').map((one) => one.segment)).toEqual(['b', 'a']);
  });

  it('tells a field apart from a group of them', () => {
    const [uptime, broker] = branchesUnder(fields, '');

    expect(uptime).toMatchObject({ field: 'uptime', under: null, count: 1 });
    expect(broker).toMatchObject({ field: null, under: 'broker.', count: 3 });
  });

  it('opens a group onto what is directly under it, and no deeper', () => {
    expect(branchesUnder(fields, 'broker.')).toMatchObject([
      { segment: 'port', field: 'broker.port' },
      { segment: 'session', under: 'broker.session.', count: 2 },
    ]);
  });

  it('walks all the way down to the fields themselves', () => {
    expect(branchesUnder(fields, 'broker.session.').map((one) => one.field)).toEqual([
      'broker.session.clean',
      'broker.session.expiryInterval',
    ]);
  });

  // An array is segments like any other, which is what makes a list of radios navigable at all.
  it('treats the indices of an array as segments', () => {
    expect(branchesUnder(fields, 'radios.').map((one) => one.segment)).toEqual(['0', '1']);
  });

  it('has nothing to show under a prefix no field is below', () => {
    expect(branchesUnder(fields, 'gone.')).toEqual([]);
  });

  // The prefix carries its own trailing dot precisely so this cannot happen: matched by splitting
  // and rejoining, a segment holding a dot would come apart into two levels that are not there.
  it('does not take a segment with a dot in it for two', () => {
    expect(branchesUnder(['a.b.c'], '')).toMatchObject([{ segment: 'a', under: 'a.' }]);
    expect(branchesUnder(['a.b.c'], 'a.')).toMatchObject([{ segment: 'b', under: 'a.b.' }]);
  });
});

describe('above', () => {
  it('steps out one level at a time, and stops at the top', () => {
    expect(above('broker.session.')).toBe('broker.');
    expect(above('broker.')).toBe('');
    expect(above('')).toBe('');
  });
});

describe('named', () => {
  it('says a prefix without the dot that makes it one', () => {
    expect(named('broker.session.')).toBe('broker.session');
  });
});

describe('clip', () => {
  it('leaves a name a chip can hold alone', () => {
    expect(clip('uptime')).toBe('uptime');
    expect(clip('a'.repeat(MOST_CHARS))).toBe('a'.repeat(MOST_CHARS));
  });

  // The two dots are part of the width rather than added past it: a chip that grew by two
  // characters to say it had been cut would be the shift this exists to stop.
  it('cuts a longer one to the width, dots included', () => {
    const cut = clip('expiryIntervalSeconds');

    expect(cut).toBe('expiryInterval..');
    expect(cut).toHaveLength(MOST_CHARS);
  });

  it('takes a width of its own', () => {
    expect(clip('expiryInterval', 8)).toBe('expiry..');
  });
});
