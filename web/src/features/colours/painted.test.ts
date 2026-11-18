import { describe, expect, it } from 'vitest';
import { createRuleLookup, type ColourRule } from '../../lib/topicColour';
import { applyMessage, emptyTree } from '../../lib/topicTree';
import { paintedBy } from './painted';

const tree = () => {
  let root = emptyTree();
  root = applyMessage(root, 'plant/boiler/temp', '21', 100);
  root = applyMessage(root, 'plant/boiler/flow', '3', 200);
  root = applyMessage(root, 'plant/kiln/temp', '1180', 300);
  root = applyMessage(root, 'site/gateway/rssi', '-67', 400);
  return root;
};

describe('paintedBy', () => {
  it('counts the topics a rule covers', () => {
    const painted = paintedBy(tree(), [{ filter: 'plant/#', colour: '#111111' }]);

    expect(painted.get('plant/#')).toBe(3);
  });

  it('gives a topic to the more specific rule, wherever that rule sits in the list', () => {
    const painted = paintedBy(tree(), [
      { filter: 'plant/#', colour: '#111111' },
      { filter: 'plant/boiler/temp', colour: '#222222' },
    ]);

    expect(painted.get('plant/boiler/temp')).toBe(1);
    // The two the specific rule did not take.
    expect(painted.get('plant/#')).toBe(2);
  });

  it('says nothing at all for a rule another one has taken every topic off', () => {
    const painted = paintedBy(tree(), [
      { filter: 'plant/boiler/#', colour: '#111111' },
      { filter: 'plant/boiler/+', colour: '#222222' },
    ]);

    expect(painted.get('plant/boiler/+')).toBe(2);
    expect(painted.get('plant/boiler/#')).toBe(0);
  });

  it('reports every rule it was given, including the ones matching nothing', () => {
    const painted = paintedBy(tree(), [{ filter: 'nowhere/#', colour: '#111111' }]);

    expect(painted.get('nowhere/#')).toBe(0);
  });

  it('answers for a rule whose filter has not been typed yet', () => {
    const painted = paintedBy(tree(), [{ filter: '', colour: '#111111' }]);

    expect(painted.get('')).toBe(0);
  });

  it('counts topics rather than branches', () => {
    // 'plant' and 'plant/boiler' are levels in a path; neither has carried a message.
    const painted = paintedBy(tree(), [{ filter: '#', colour: '#111111' }]);

    expect(painted.get('#')).toBe(4);
  });

  /*
   * The count and the paint are the same question asked twice, so they are asked in the same
   * words: this counts through the very lookup the tree paints with. A rule that lookup discards —
   * one whose colour is not a usable triple — paints nothing, and so counts nothing. Passing a
   * placeholder colour here to 'simplify' is what made every count in the panel read nought.
   */
  it('counts nothing for a rule the painter itself would discard', () => {
    const painted = paintedBy(tree(), [{ filter: 'plant/#', colour: 'not a colour' }]);

    expect(painted.get('plant/#')).toBe(0);
  });

  it('has nothing to count on a broker that has not spoken', () => {
    expect(paintedBy(emptyTree(), [{ filter: '#', colour: '#111111' }]).get('#')).toBe(0);
  });

  /*
   * The count no longer asks the painter about every topic one at a time — at fifty thousand
   * topics that took most of a second — but it must still give the painter's answer. So it is
   * held to that answer here, topic by topic, over the corners a filter has: a '#' that covers
   * its own parent, a '+', a '$' topic no leading wildcard may reach, a topic that opens with '/',
   * and rules that overlap so only the more specific one wins.
   */
  describe('agrees with the painter, topic by topic', () => {
    const topics = [
      'plant/boiler/temp',
      'plant/boiler/flow',
      'plant/boiler',
      'plant/kiln/temp',
      'plant/kiln/zone/1/temp',
      'plant',
      'site/gateway/rssi',
      '$SYS/broker/load',
      '$SYS/broker/clients',
      '/hfp/v2/bus/1',
      '/hfp/v2/tram/2',
      'a/b/c/d/e',
    ];
    let root = emptyTree();
    topics.forEach((topic, at) => (root = applyMessage(root, topic, '1', at + 1)));

    // The painter's own answer, asked of every topic.
    const byThePainter = (rules: ColourRule[]) => {
      const winner = createRuleLookup(rules);
      const counts = new Map(rules.map((rule) => [rule.filter, 0]));
      for (const topic of topics) {
        const rule = winner(topic);
        if (rule) counts.set(rule.filter, counts.get(rule.filter)! + 1);
      }
      return counts;
    };

    const sets: string[][] = [
      ['#'],
      ['+/#'],
      ['plant/#'],
      ['plant/boiler/#'],
      ['plant/+'],
      ['plant/+/temp'],
      ['plant/+/#', 'plant/boiler/temp'],
      ['#', 'plant/#', 'plant/boiler/+', 'plant/kiln/zone/1/temp'],
      ['$SYS/#', '+/broker/#'],
      ['/hfp/#', '/+/v2/+/1', '+/+/+'],
      ['+/+/+/+/+', 'a/#', 'a/b/c/d/e'],
      ['nowhere/#', 'plant/kiln'],
    ];

    it.each(sets.map((filters) => [filters.join('  ')] as const))('%s', (joined) => {
      const rules = joined.split('  ').map((filter, at) => ({ filter, colour: `#00000${at}` }));

      expect(paintedBy(root, rules)).toEqual(byThePainter(rules));
    });
  });
});
