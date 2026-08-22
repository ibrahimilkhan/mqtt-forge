import { beforeEach, describe, expect, it } from 'vitest';
import { byteLength } from '../lib/payload';
import type { DecodedMessage } from '../realtime/decodeIncoming';
import {
  narrowRuns,
  MIN_TOPIC_ENTRIES,
  runFor,
  TOPIC_BYTES,
  TOPIC_DEPTH,
  useLogStore,
} from './logStore';
import { TopicRing } from './topicRing';

const message = (
  topic: string,
  payload: string,
  extra: Partial<DecodedMessage> = {},
): DecodedMessage => ({
  topic,
  payload,
  mode: 'text',
  size: byteLength(payload),
  qos: 0,
  retain: false,
  receivedAt: '2026-07-26T10:00:00Z',
  ...extra,
});

/** The traffic across every topic, newest first — what the pane reads under a bare '#'. */
const arrivals = () => runFor(useLogStore.getState().byTopic, '#');
const on = (topic: string) => runFor(useLogStore.getState().byTopic, topic);
const send = (...messages: DecodedMessage[]) => useLogStore.getState().appendReceived(messages);

beforeEach(() => useLogStore.getState().clear());

describe('what the log makes of an arrival', () => {
  it('keeps a batch in newest-first order', () => {
    send(message('a', '1'), message('b', '2'), message('c', '3'));

    expect(arrivals().map((e) => e.topic)).toEqual(['c', 'b', 'a']);
  });

  it('turns QoS, retain and payload size into stamps', () => {
    send(message('a', '1', { qos: 2, retain: true }));

    expect(arrivals()[0]).toMatchObject({
      kind: 'recv',
      topic: 'a',
      body: '1',
      stamps: ['QoS 2', 'RETAINED', '1B'],
    });
  });

  // Only commands carry a verb. Everything that reaches the pane arrived, so a word saying so
  // on each of them told nobody anything they could not see from the pane.
  it('gives an arrival no verb of its own', () => {
    send(message('a', '1'));

    expect(arrivals()[0].verb).toBeUndefined();
  });

  it('leaves the retained stamp off when the message is not retained', () => {
    send(message('a', '1', { qos: 1 }));

    expect(arrivals()[0].stamps).toEqual(['QoS 1', '1B']);
  });

  it('sizes the payload in bytes, not characters', () => {
    send(message('a', 'ölçüm'));

    expect(arrivals()[0].stamps).toContain('8B');
  });

  it('switches to kB once the payload passes a kilobyte', () => {
    send(message('a', 'x'.repeat(2048)));

    expect(arrivals()[0].stamps).toContain('2.0kB');
  });

  it('stamps a binary arrival with its real byte count, not the hex length', () => {
    send(message('a', '01 A4 FF', { mode: 'hex', size: 3 }));

    expect(arrivals()[0]).toMatchObject({ mode: 'hex' });
    expect(arrivals()[0].stamps).toEqual(expect.arrayContaining(['3B', 'BIN']));
  });
});

describe('what this console did', () => {
  it('puts the newest command first', () => {
    useLogStore.getState().push({ kind: 'ok', verb: 'Connected' });
    useLogStore.getState().push({ kind: 'ok', verb: 'Subscribed' });

    expect(useLogStore.getState().commands.map((e) => e.verb)).toEqual(['Subscribed', 'Connected']);
  });

  it('gives every entry a distinct id', () => {
    useLogStore.getState().push({ kind: 'ok', verb: 'A' });
    useLogStore.getState().push({ kind: 'ok', verb: 'B' });

    const [first, second] = useLogStore.getState().commands;
    expect(first.id).not.toBe(second.id);
  });

  // Commands and traffic are different questions asked in different places, and neither should
  // be able to push the other out.
  it('keeps commands and traffic apart', () => {
    send(message('a', '1'));
    useLogStore.getState().push({ kind: 'ok', verb: 'Subscribed', topic: 'a/#' });

    expect(useLogStore.getState().commands).toHaveLength(1);
    expect(arrivals()).toHaveLength(1);
    expect(arrivals()[0].verb).toBeUndefined();
  });

  // The renderer seeds the console this way, and an arrival is traffic however it got here.
  it('files an arrival pushed by hand with the traffic', () => {
    useLogStore.getState().push({ kind: 'recv', topic: 'a', body: '1' });

    expect(arrivals()).toHaveLength(1);
    expect(useLogStore.getState().commands).toHaveLength(0);
  });
});

/**
 * The whole point of the shape. A topic's history used to be a matter of what every other topic
 * was doing — a tram that finished its journey had its messages pushed out by traffic elsewhere
 * within a couple of minutes, and the pane then said none had ever arrived while the tree went
 * on counting them.
 */
describe('what a topic keeps', () => {
  it('keeps its own run to the depth it is given', () => {
    send(...Array.from({ length: TOPIC_DEPTH + 50 }, (_, i) => message('one', String(i))));

    const run = on('one');
    expect(run).toHaveLength(TOPIC_DEPTH);
    expect(run[0].body).toBe(String(TOPIC_DEPTH + 49));
  });

  it('cannot have its history shortened by another topic, however loud', () => {
    send(message('quiet/one', 'hello'));
    send(...Array.from({ length: TOPIC_DEPTH * 4 }, (_, i) => message('chatty', String(i))));

    expect(on('quiet/one')).toHaveLength(1);
    expect(on('quiet/one')[0].body).toBe('hello');
  });

  it('keeps a full run each even when the broker has thousands of topics', () => {
    for (let t = 0; t < 2000; t++) send(message(`crowd/${t}`, '.'));
    send(...Array.from({ length: TOPIC_DEPTH }, (_, i) => message('watched', String(i))));

    expect(on('watched')).toHaveLength(TOPIC_DEPTH);
    expect(on('crowd/7')).toHaveLength(1);
  });

  // A count is not a memory bound. One topic sending megabytes would otherwise hold as many as
  // one sending bytes.
  it('stops on weight before it reaches the depth, when the payloads are heavy', () => {
    const heavy = 'x'.repeat(TOPIC_BYTES / 10);
    send(...Array.from({ length: 30 }, () => message('fat', heavy)));

    expect(on('fat').length).toBeLessThanOrEqual(11);
    expect(on('fat').length).toBeGreaterThan(0);
  });
});

/**
 * The one bound that is about the machine rather than about a topic. Reached by breadth — more
 * topics than the ceiling affords at TOPIC_DEPTH — rather than by any topic's own depth, so it
 * is tested on the rule itself rather than by sending a million messages.
 */
/**
 * The one bound that is about the machine rather than about a topic, and reached by breadth:
 * more topics than the ceiling affords at TOPIC_DEPTH. Exercised on the rule with a small
 * ceiling rather than by sending a million messages.
 */
describe('the ceiling across every topic', () => {
  const ringOf = (count: number, from = 0) => {
    const ring = new TopicRing({ maxItems: TOPIC_DEPTH, maxBytes: TOPIC_BYTES });
    for (let i = 0; i < count; i++) {
      ring.push({ id: from + i, kind: 'recv', at: new Date(0), topic: 't', body: '.' });
    }
    return ring;
  };
  const crowd = (topics: number, each: number) =>
    new Map(Array.from({ length: topics }, (_, i) => [`t/${i}`, ringOf(each, i * 1000)]));

  // The fault this whole shape exists to end: a topic the log threw away entirely still stands
  // in the tree with its count, and clicking it says nothing ever arrived.
  it('makes every run shorter rather than throwing topics away', () => {
    const byTopic = crowd(10, 100);

    const held = narrowRuns(byTopic, 1000, 500);

    expect(byTopic.size).toBe(10);
    expect(held).toBeLessThanOrEqual(500);
    for (const ring of byTopic.values()) expect(ring.length).toBe(50);
  });

  it('leaves the newest of each run, not the oldest', () => {
    // Above the floor, or the floor itself would be more than the ceiling and the run would be
    // dropped rather than narrowed — which is the case the test below is about.
    const byTopic = new Map([['only', ringOf(100)]]);

    narrowRuns(byTopic, 100, 40);

    const kept = byTopic.get('only')!.newestFirst();
    expect(kept).toHaveLength(40);
    expect(kept[0].id).toBe(99);
    expect(kept.at(-1)!.id).toBe(60);
  });

  // A run has to stay long enough to be one; below the floor the pane shows a line replaced on
  // every arrival, which is no history at all.
  it('never narrows a run below the floor', () => {
    const byTopic = crowd(100, 100);

    narrowRuns(byTopic, 10_000, 100);

    for (const ring of byTopic.values()) expect(ring.length).toBe(MIN_TOPIC_ENTRIES);
  });

  // Only once even the floor will not fit does anything get dropped, which takes tens of
  // thousands of topics on the real ceiling.
  it('drops the quietest topics only when the floor still does not fit', () => {
    const byTopic = new Map([
      ['stale', ringOf(MIN_TOPIC_ENTRIES, 0)],
      ['older', ringOf(MIN_TOPIC_ENTRIES, 1_000)],
      ['live', ringOf(MIN_TOPIC_ENTRIES, 9_000)],
    ]);

    narrowRuns(byTopic, MIN_TOPIC_ENTRIES * 3, MIN_TOPIC_ENTRIES);

    expect([...byTopic.keys()]).toEqual(['live']);
  });

  it('leaves a console inside its ceiling alone', () => {
    const byTopic = crowd(4, 10);

    expect(narrowRuns(byTopic, 40, 500)).toBe(40);
    expect(byTopic.size).toBe(4);
    for (const ring of byTopic.values()) expect(ring.length).toBe(10);
  });
});

describe('clearing', () => {
  it('takes the traffic and the commands together', () => {
    send(message('a', '1'));
    useLogStore.getState().push({ kind: 'ok', verb: 'Connected' });

    useLogStore.getState().clear();

    expect(arrivals()).toEqual([]);
    expect(useLogStore.getState().commands).toEqual([]);
    expect(useLogStore.getState().held).toBe(0);
  });
});
