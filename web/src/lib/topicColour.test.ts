import { describe, expect, it } from 'vitest';
import { createRuleLookup, isColour, sortRules, type ColourRule } from './topicColour';

const rule = (filter: string, colour = '#b45309'): ColourRule => ({ filter, colour });

describe('isColour', () => {
  it.each(['#b45309', '#B45309', '#000000', '#ffffff'])('accepts %s', (value) => {
    expect(isColour(value)).toBe(true);
  });

  // The value goes straight into an inline style, so anything that is not a hex triple is
  // refused here rather than trusted because the server said so.
  it.each([
    'red',
    '#fff',
    '#gggggg',
    '#b45309ff',
    'b45309',
    'rgb(1,2,3)',
    '#b45309; background: url(x)',
    ' #b45309',
    '',
    null,
    undefined,
    42,
    {},
  ])('refuses %s', (value) => {
    expect(isColour(value)).toBe(false);
  });
});

describe('sortRules', () => {
  it('puts the more specific filter first', () => {
    const sorted = sortRules([rule('sensors/#'), rule('sensors/+/temp')]);

    expect(sorted.map((r) => r.filter)).toEqual(['sensors/+/temp', 'sensors/#']);
  });

  it('drops a rule whose colour is not a hex triple', () => {
    const sorted = sortRules([rule('sensors/#', 'red'), rule('alerts/#')]);

    expect(sorted.map((r) => r.filter)).toEqual(['alerts/#']);
  });

  it('drops a rule whose filter is malformed', () => {
    const sorted = sortRules([rule('a/#/b'), rule('a/b+'), rule(''), rule('alerts/#')]);

    expect(sorted.map((r) => r.filter)).toEqual(['alerts/#']);
  });

  it('leaves the caller`s array untouched', () => {
    const rules = [rule('sensors/#'), rule('sensors/+/temp')];

    sortRules(rules);

    expect(rules.map((r) => r.filter)).toEqual(['sensors/#', 'sensors/+/temp']);
  });
});

describe("rule lookup precedence", () => {
  // Every pair: both filters match the topic, and the first is the one that should win.
  const contests: ReadonlyArray<[topic: string, winner: string, loser: string]> = [
    // A concrete segment beats a '+' in the same place.
    ['sensors/a/temp', 'sensors/a/temp', 'sensors/+/temp'],
    // '+' beats '#': it is bounded, '#' is open-ended.
    ['sensors/a/temp', 'sensors/+/temp', 'sensors/#'],
    // Concreteness is read left to right, so it decides before length does.
    ['sensors/a/temp', 'sensors/a/#', 'sensors/+/#'],
    // The longer '#' filter names more of the path.
    ['a/b/c/d', 'a/b/c/#', 'a/b/#'],
    ['a/b/c/d', 'a/b/#', 'a/#'],
    ['a/b/c/d', 'a/#', '#'],
    // A filter that ends exactly here beats one that carries on with '#'.
    ['a/b', 'a/b', 'a/b/#'],
    ['a/b', 'a/+', 'a/#'],
    // A concrete segment early beats a longer run of wildcards.
    ['a/b/c/d', 'a/b/#', 'a/+/+/+'],
    // Exact match beats everything.
    ['a/b/c', 'a/b/c', 'a/+/+'],
  ];

  it.each(contests)('on %s, %s beats %s', (topic, winner, loser) => {
    // Both orderings, so the answer comes from the comparison and not from where they sat.
    const forwards = createRuleLookup([rule(winner, '#111111'), rule(loser, '#222222')]);
    const backwards = createRuleLookup([rule(loser, '#222222'), rule(winner, '#111111')]);

    expect(forwards(topic)?.filter).toBe(winner);
    expect(backwards(topic)?.filter).toBe(winner);
  });
});

describe('createRuleLookup', () => {
  it('returns null for a topic no rule covers', () => {
    const lookup = createRuleLookup([rule('sensors/#')]);

    expect(lookup('actuators/valve')).toBeNull();
  });

  it('returns null when there are no rules at all', () => {
    expect(createRuleLookup([])('sensors/a/temp')).toBeNull();
  });

  // The filter, not just the colour: with rules overlapping, which one painted the row is
  // exactly what the row has to be able to say.
  it('names the rule that matched, not only its colour', () => {
    const lookup = createRuleLookup([rule('sensors/#', '#111111'), rule('sensors/+/temp', '#222222')]);

    expect(lookup('sensors/a/temp')).toEqual({ filter: 'sensors/+/temp', colour: '#222222' });
  });

  it('normalises the colour it hands back to lower case', () => {
    const lookup = createRuleLookup([rule('sensors/#', '#B45309')]);

    expect(lookup('sensors/a')?.colour).toBe('#b45309');
  });

  it('covers the level a # hangs off, as MQTT does', () => {
    const lookup = createRuleLookup([rule('sensors/#')]);

    expect(lookup('sensors')?.colour).toBe('#b45309');
  });

  // A memoised row is handed this object as a prop; a fresh one per render would defeat the memo.
  it('hands back the same object every time, so a memoised row sees an unchanged prop', () => {
    const lookup = createRuleLookup([rule('sensors/+/temp')]);

    expect(lookup('sensors/a/temp')).toBe(lookup('sensors/a/temp'));
    expect(lookup('sensors/a/hum')).toBeNull();
    expect(lookup('sensors/a/hum')).toBeNull();
  });

  // The memo would otherwise hand back answers from a rule list that no longer exists.
  it('snapshots the rules it was given, so later edits to the array do not leak in', () => {
    const rules = [rule('sensors/#', '#b45309')];
    const lookup = createRuleLookup(rules);

    rules[0] = rule('sensors/#', '#111111');
    rules.push(rule('other/#', '#222222'));

    expect(lookup('sensors/a')?.colour).toBe('#b45309');
    expect(lookup('other/x')).toBeNull();
  });

  it('handles an empty topic without matching a rooted filter', () => {
    const lookup = createRuleLookup([rule('sensors/#')]);

    expect(lookup('')).toBeNull();
  });

  // A '#' subscription on a busy broker asks this once per row, on every render that carries
  // traffic. The answer has to come off the memo rather than out of a rescan.
  it('answers a topic it has already seen without walking the rules again', () => {
    const many = Array.from({ length: 100 }, (_, i) => rule(`branch${i}/#`, '#b45309'));
    const lookup = createRuleLookup(many);
    const topics = Array.from({ length: 1500 }, (_, i) => `branch${i % 100}/device${i}/state`);

    topics.forEach(lookup);

    const start = performance.now();
    topics.forEach(lookup);
    const secondPass = performance.now() - start;

    // Generous by design: this is a rescan/no-rescan gap of two orders of magnitude, not a
    // benchmark, so a slow machine cannot make it flap.
    expect(secondPass).toBeLessThan(20);
  });
});
