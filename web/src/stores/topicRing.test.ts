import { describe, expect, it } from 'vitest';
import type { LogEntry } from './logStore';
import { TopicRing } from './topicRing';

let id = 0;
const entry = (body = 'x'): LogEntry => ({ id: id++, kind: 'recv', at: 0, topic: 't', body });

const bodies = (ring: TopicRing) => ring.newestFirst().map((e) => e.body);

describe('what a topic keeps', () => {
  it('gives back what it was given, newest first', () => {
    const ring = new TopicRing({ maxItems: 10, maxBytes: 1000 });
    ['a', 'b', 'c'].forEach((b) => ring.push(entry(b)));

    expect(bodies(ring)).toEqual(['c', 'b', 'a']);
    expect(ring.length).toBe(3);
  });

  it('is empty until something arrives', () => {
    expect(new TopicRing({ maxItems: 10, maxBytes: 1000 }).newestFirst()).toEqual([]);
  });

  it('drops the oldest once it is full', () => {
    const ring = new TopicRing({ maxItems: 3, maxBytes: 1000 });
    ['a', 'b', 'c', 'd'].forEach((b) => ring.push(entry(b)));

    expect(bodies(ring)).toEqual(['d', 'c', 'b']);
    expect(ring.length).toBe(3);
  });

  // A count alone is not a memory bound: one topic sending megabytes would hold as much as one
  // sending bytes.
  it('drops on weight as well as on count', () => {
    const ring = new TopicRing({ maxItems: 100, maxBytes: 10 });
    ring.push(entry('aaaaa'));
    ring.push(entry('bbbbb'));
    ring.push(entry('ccccc'));

    expect(bodies(ring)).toEqual(['ccccc', 'bbbbb']);
  });

  // The newest arrival is the one thing the pane always has to be able to show, however big it
  // is — a run of one is the floor, not something the weight bound can cut into.
  it('keeps the newest even when it is heavier than the whole budget', () => {
    const ring = new TopicRing({ maxItems: 100, maxBytes: 10 });
    ring.push(entry('small'));
    ring.push(entry('x'.repeat(500)));

    expect(ring.length).toBe(1);
    expect(bodies(ring)).toEqual(['x'.repeat(500)]);
  });

  it('lets weight go again as the entries carrying it fall off', () => {
    const ring = new TopicRing({ maxItems: 100, maxBytes: 12 });
    ring.push(entry('x'.repeat(10)));
    ['a', 'b', 'c'].forEach((b) => ring.push(entry(b)));

    expect(bodies(ring)).toEqual(['c', 'b', 'a']);
  });

  // The point of the shape: adding stays cheap however long the topic has been running, and the
  // array behind it does not grow without end as entries are dropped.
  it('holds its bound over a run far longer than itself', () => {
    const ring = new TopicRing({ maxItems: 50, maxBytes: 1_000_000 });
    for (let i = 0; i < 50_000; i++) ring.push(entry(`m${i}`));

    expect(ring.length).toBe(50);
    expect(bodies(ring)[0]).toBe('m49999');
    expect(bodies(ring)[49]).toBe('m49950');
  });
});
