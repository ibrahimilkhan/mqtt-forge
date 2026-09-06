import { beforeEach, describe, expect, it } from 'vitest';
import { byteLength } from '../lib/payload';
import type { DecodedMessage } from '../realtime/decodeIncoming';
import {
  DEFAULT_LOAD_BYTES,
  heldWeight,
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

beforeEach(() => {
  useLogStore.getState().clear();
  // A budget one test lowered is not a budget the next one asked for.
  useLogStore.setState({ budget: DEFAULT_LOAD_BYTES });
});

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

  // A count is not a memory bound — but the weight bound is the console's, not the topic's, and
  // it is not spent until the console is full. Thirty heavy messages on a console holding eight
  // megabytes is not a machine in trouble, and this used to keep eleven of them.
  it('keeps every heavy message while the console has room for it', () => {
    const heavy = 'x'.repeat(TOPIC_BYTES / 10);
    send(...Array.from({ length: 30 }, () => message('fat', heavy)));

    expect(on('fat')).toHaveLength(30);
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

// What the runs weigh together, for the line that reports what the console is carrying.
describe('what the log weighs', () => {
  it('adds up the bodies it is holding', () => {
    send(message('a', 'x'.repeat(100)), message('b', 'y'.repeat(50)));

    expect(heldWeight(useLogStore.getState().byTopic)).toBe(150);
  });

  it('weighs nothing when nothing has arrived', () => {
    expect(heldWeight(useLogStore.getState().byTopic)).toBe(0);
  });

  // A run cut back to its depth is lighter, and the weight has to follow it down.
  it('lets go of the weight a run has dropped', () => {
    send(...Array.from({ length: TOPIC_DEPTH + 200 }, () => message('one', 'x'.repeat(10))));

    expect(heldWeight(useLogStore.getState().byTopic)).toBe(TOPIC_DEPTH * 10);
  });
});

// A message is never cut down to fit. The tree keeps the first four kilobytes of a body for the
// value on its row; the log is where the whole thing lives, and a reader who opens a message or
// publishes it again must get every byte the broker sent. Verified against the lab at 300 kB and
// 1 MB; this is the line that keeps it true.
describe('a message far larger than the per-topic budget', () => {
  const arrival = (topic: string, payload: string) => ({
    topic,
    payload,
    mode: 'text' as const,
    size: payload.length,
    qos: 0,
    retain: false,
    receivedAt: '2026-09-06T00:00:00.000Z',
  });

  beforeEach(() => {
  useLogStore.getState().clear();
  // A budget one test lowered is not a budget the next one asked for.
  useLogStore.setState({ budget: DEFAULT_LOAD_BYTES });
});

  it('is held whole', () => {
    const body = 'z'.repeat(1_000_000);

    useLogStore.getState().appendReceived([arrival('big', body)]);

    const held = useLogStore.getState().byTopic.get('big')?.newestFirst()[0];
    expect(held?.body).toHaveLength(1_000_000);
    expect(held?.body).toBe(body);
  });

  // And what stood beside it stays. The old rule cut this run back to one message on the
  // grounds that a megabyte is more than a topic's share — of a budget the console was nowhere
  // near spending.
  it('leaves the messages beside it alone', () => {
    useLogStore
      .getState()
      .appendReceived([arrival('big', 'small'), arrival('big', 'y'.repeat(1_000_000))]);

    const run = useLogStore.getState().byTopic.get('big')?.newestFirst() ?? [];
    expect(run).toHaveLength(2);
    expect(run[0].body).toHaveLength(1_000_000);
    expect(run[1].body).toBe('small');
  });
});

/**
 * The bound that is about the machine, and the only one the reader sets.
 *
 * Everything above holds while there is room. This is what happens when there is not: the
 * per-topic weight cap comes on for every run at once, and whole topics go only if even that is
 * not enough. The budget is in the store rather than a constant so a test can reach it without
 * sending five hundred megabytes.
 */
describe('the memory budget', () => {
  const heavy = (n: number) => 'x'.repeat(n);

  it('holds everything while what it holds is under the budget', () => {
    send(...Array.from({ length: 8 }, (_, i) => message('fat', heavy(TOPIC_BYTES) + i)));

    expect(on('fat')).toHaveLength(8);
    expect(useLogStore.getState().capped).toBe(false);
  });

  it('counts what it is holding as it goes', () => {
    send(message('a', heavy(1000)), message('b', heavy(500)));

    expect(useLogStore.getState().weight).toBe(1500);
    expect(useLogStore.getState().weight).toBe(heldWeight(useLogStore.getState().byTopic));
  });

  it('cuts every run back to the per-topic weight once it is over', () => {
    useLogStore.setState({ budget: TOPIC_BYTES * 3 });

    // Two topics, four heavy messages each: eight times the per-topic weight in all.
    for (let i = 0; i < 4; i++) send(message('one', heavy(TOPIC_BYTES)), message('two', heavy(TOPIC_BYTES)));

    const state = useLogStore.getState();
    expect(state.capped).toBe(true);
    expect(state.byTopic.get('one')!.weight).toBeLessThanOrEqual(TOPIC_BYTES);
    expect(state.byTopic.get('two')!.weight).toBeLessThanOrEqual(TOPIC_BYTES);
    // Depth gave way; neither topic was dropped.
    expect(on('one').length).toBeGreaterThan(0);
    expect(on('two').length).toBeGreaterThan(0);
  });

  it('keeps the newest of what it cuts', () => {
    useLogStore.setState({ budget: TOPIC_BYTES * 2 });

    send(message('one', `first${heavy(TOPIC_BYTES)}`));
    send(message('one', `second${heavy(TOPIC_BYTES)}`));
    send(message('one', `third${heavy(TOPIC_BYTES)}`));

    expect(on('one')[0].body!.startsWith('third')).toBe(true);
  });

  it('bounds a topic first heard from while it is full', () => {
    useLogStore.setState({ budget: TOPIC_BYTES });
    send(message('one', heavy(TOPIC_BYTES * 2)));
    expect(useLogStore.getState().capped).toBe(true);

    for (let i = 0; i < 4; i++) send(message('later', heavy(TOPIC_BYTES)));

    expect(useLogStore.getState().byTopic.get('later')!.weight).toBeLessThanOrEqual(TOPIC_BYTES);
  });

  // The last resort, and the same rule the count ceiling uses: a topic still moving is one
  // somebody may be watching, so the ones that go are those whose newest message is oldest.
  it('drops the quietest topics when a run each is still too much', () => {
    useLogStore.setState({ budget: TOPIC_BYTES * 2 });

    for (let t = 0; t < 6; t++) send(message(`crowd/${t}`, heavy(TOPIC_BYTES)));

    const kept = [...useLogStore.getState().byTopic.keys()];
    expect(kept.length).toBeLessThan(6);
    expect(kept).toContain('crowd/5');
    expect(kept).not.toContain('crowd/0');
  });

  describe('when the reader changes it', () => {
    // It is told the stored choice on every change of any stored choice, so the common call is
    // one that changes nothing here.
    it('does not lift the cap when it is told the same budget again', () => {
      useLogStore.setState({ budget: TOPIC_BYTES });
      send(...Array.from({ length: 4 }, () => message('fat', heavy(TOPIC_BYTES))));
      expect(useLogStore.getState().capped).toBe(true);

      useLogStore.getState().setBudget(TOPIC_BYTES);

      expect(useLogStore.getState().capped).toBe(true);
    });

    it('cuts back at once on a budget the console is already past', () => {
      send(...Array.from({ length: 6 }, () => message('fat', heavy(TOPIC_BYTES))));
      expect(useLogStore.getState().capped).toBe(false);

      useLogStore.getState().setBudget(TOPIC_BYTES * 2);

      expect(useLogStore.getState().capped).toBe(true);
      expect(useLogStore.getState().byTopic.get('fat')!.weight).toBeLessThanOrEqual(TOPIC_BYTES);
    });

    it('lets the runs grow again on a budget with room in it', () => {
      useLogStore.setState({ budget: TOPIC_BYTES });
      send(...Array.from({ length: 4 }, () => message('fat', heavy(TOPIC_BYTES))));
      expect(useLogStore.getState().capped).toBe(true);

      useLogStore.getState().setBudget(DEFAULT_LOAD_BYTES);
      send(...Array.from({ length: 4 }, () => message('fat', heavy(TOPIC_BYTES))));

      expect(useLogStore.getState().capped).toBe(false);
      expect(useLogStore.getState().byTopic.get('fat')!.weight).toBeGreaterThan(TOPIC_BYTES);
    });

    it('leaves what is held alone when the new budget still fits it', () => {
      send(message('a', heavy(1000)));

      useLogStore.getState().setBudget(TOPIC_BYTES);

      expect(on('a')).toHaveLength(1);
      expect(useLogStore.getState().capped).toBe(false);
      expect(useLogStore.getState().budget).toBe(TOPIC_BYTES);
    });
  });

  it('is not under pressure once it is holding nothing', () => {
    useLogStore.setState({ budget: TOPIC_BYTES });
    send(message('one', heavy(TOPIC_BYTES * 2)));
    expect(useLogStore.getState().capped).toBe(true);

    useLogStore.getState().clear();

    expect(useLogStore.getState().capped).toBe(false);
    expect(useLogStore.getState().weight).toBe(0);
  });

  it('stops counting what a forgotten topic weighed', () => {
    send(message('going', heavy(1000)), message('staying', heavy(500)));

    useLogStore.getState().forgetTopics(['going']);

    expect(useLogStore.getState().weight).toBe(500);
  });
});
