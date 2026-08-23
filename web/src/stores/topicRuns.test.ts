import { describe, expect, it } from 'vitest';
import { TopicRing } from './topicRing';
import { TopicRuns } from './topicRuns';

const BOUNDS = { maxItems: 10, maxBytes: 1000 };

const runs = (...topics: string[]): TopicRuns => {
  const held = new TopicRuns();
  for (const topic of topics) {
    const ring = new TopicRing(BOUNDS);
    ring.push({ id: held.size, kind: 'recv', at: 0, topic, body: topic });
    held.set(topic, ring);
  }

  return held;
};

// A run is identified by the one entry put in it, so a list of rings reads back as topics.
const topicsOf = (found: TopicRing[]): string[] => found.map((ring) => ring.newestFirst()[0].topic!);

describe('TopicRuns', () => {
  it('answers as the map it stands in for', () => {
    const held = runs('a/b', 'a/c');

    expect(held.size).toBe(2);
    expect(held.has('a/b')).toBe(true);
    expect(held.has('a/z')).toBe(false);
    expect(held.get('a/z')).toBeUndefined();
    expect([...held.keys()]).toEqual(['a/b', 'a/c']);
    expect([...held].map(([topic]) => topic)).toEqual(['a/b', 'a/c']);
  });

  it('covers the branch itself and everything beneath it', () => {
    const held = runs('plant', 'plant/line1', 'plant/line1/cell2', 'plant/line2');

    expect(topicsOf(held.covering('plant'))).toEqual([
      'plant',
      'plant/line1',
      'plant/line1/cell2',
      'plant/line2',
    ]);
    expect(topicsOf(held.covering('plant/line1'))).toEqual(['plant/line1', 'plant/line1/cell2']);
  });

  /**
   * The hazard the order brings with it: '.' sorts before '/', so a topic that merely begins
   * with the branch's letters lands between the branch and its children. A walk that stopped at
   * the first topic not under the branch would lose everything after this one.
   */
  it('passes over topics that only begin with the branch', () => {
    const held = runs('plant.spare', 'plantation/line1', 'plant', 'plant/line1', 'plants');

    expect(topicsOf(held.covering('plant'))).toEqual(['plant', 'plant/line1']);
  });

  it('gives a branch nothing has arrived under nothing', () => {
    expect(runs('a/b').covering('nobody')).toEqual([]);
    expect(new TopicRuns().covering('a')).toEqual([]);
  });

  it('orders what it finds by topic, whatever order the topics arrived in', () => {
    const held = runs('z/9', 'z/1', 'z/10', 'z/2');

    expect(topicsOf(held.covering('z'))).toEqual(['z/1', 'z/10', 'z/2', 'z/9']);
    expect(topicsOf(held.all())).toEqual(['z/1', 'z/10', 'z/2', 'z/9']);
  });

  it('takes in topics named after a read without losing the ones before it', () => {
    const held = runs('b');
    expect(topicsOf(held.all())).toEqual(['b']);

    held.set('a', runs('a').get('a')!);
    held.set('c', runs('c').get('c')!);

    expect(topicsOf(held.all())).toEqual(['a', 'b', 'c']);
  });

  /**
   * Eviction takes topics out, and a topic that goes quiet enough to be evicted can speak again
   * a moment later. Its name is then in the settled order and in the list waiting to join it,
   * and a run counted twice would draw a topic's messages twice.
   */
  it('holds a topic once when it is evicted and then heard from again', () => {
    const held = runs('a', 'b', 'c');
    expect(topicsOf(held.all())).toEqual(['a', 'b', 'c']);

    expect(held.delete('b')).toBe(true);
    expect(held.delete('b')).toBe(false);
    expect(topicsOf(held.all())).toEqual(['a', 'c']);

    held.set('b', runs('b').get('b')!);

    expect(topicsOf(held.all())).toEqual(['a', 'b', 'c']);
    expect(topicsOf(held.covering('b'))).toEqual(['b']);
  });

  it('drops evicted topics without waiting for a new one to arrive', () => {
    const held = runs('a', 'b');
    held.all();
    held.delete('a');

    expect(topicsOf(held.all())).toEqual(['b']);
  });

  it('is emptied whole', () => {
    const held = runs('a', 'a/b');
    held.all();
    held.clear();

    expect(held.size).toBe(0);
    expect(held.all()).toEqual([]);
    expect(held.covering('a')).toEqual([]);
  });
});
