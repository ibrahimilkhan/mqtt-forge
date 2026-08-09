import { beforeEach, describe, expect, it } from 'vitest';
import type { MqttMessage } from '../types/api';
import { MAX_LOG_ENTRIES, MIN_TOPIC_ENTRIES, useLogStore } from './logStore';

const message = (topic: string, payload: string, extra: Partial<MqttMessage> = {}): MqttMessage => ({
  topic,
  payload,
  qos: 0,
  retain: false,
  receivedAt: '2026-07-26T10:00:00Z',
  ...extra,
});

beforeEach(() => useLogStore.getState().clear());

describe('logStore', () => {
  it('puts the newest entry first', () => {
    useLogStore.getState().push({ kind: 'ok', verb: 'Connected' });
    useLogStore.getState().push({ kind: 'ok', verb: 'Subscribed' });

    expect(useLogStore.getState().entries.map((e) => e.verb)).toEqual(['Subscribed', 'Connected']);
  });

  it('keeps a batch in newest-first order too', () => {
    useLogStore.getState().appendReceived([message('a', '1'), message('b', '2'), message('c', '3')]);

    expect(useLogStore.getState().entries.map((e) => e.topic)).toEqual(['c', 'b', 'a']);
  });

  it('turns QoS, retain and payload size into stamps', () => {
    useLogStore.getState().appendReceived([message('a', '1', { qos: 2, retain: true })]);

    expect(useLogStore.getState().entries[0]).toMatchObject({
      kind: 'recv',
      verb: 'Received',
      topic: 'a',
      body: '1',
      stamps: ['QoS 2', 'RETAINED', '1 B'],
    });
  });

  it('leaves the retained stamp off when the message is not retained', () => {
    useLogStore.getState().appendReceived([message('a', '1', { qos: 1 })]);

    expect(useLogStore.getState().entries[0].stamps).toEqual(['QoS 1', '1 B']);
  });

  it('sizes the payload in bytes, not characters', () => {
    useLogStore.getState().appendReceived([message('a', 'ölçüm')]);

    expect(useLogStore.getState().entries[0].stamps).toContain('8 B');
  });

  it('switches to kB once the payload passes a kilobyte', () => {
    useLogStore.getState().appendReceived([message('a', 'x'.repeat(2048))]);

    expect(useLogStore.getState().entries[0].stamps).toContain('2.0 kB');
  });

  it('drops the oldest entries past the cap', () => {
    const flood = Array.from({ length: MAX_LOG_ENTRIES + 20 }, (_, i) => message(`t/${i}`, String(i)));

    useLogStore.getState().appendReceived(flood);

    const entries = useLogStore.getState().entries;
    expect(entries).toHaveLength(MAX_LOG_ENTRIES);
    expect(entries[0].topic).toBe(`t/${MAX_LOG_ENTRIES + 19}`);
  });

  // The log is read one topic at a time, so the cap cannot be first-come-first-served: a topic
  // under steady traffic would evict every quiet one and the pane would report them silent.
  it('keeps a quiet topic on the log while a chatty one floods it', () => {
    useLogStore.getState().appendReceived([message('quiet/one', 'hello')]);
    useLogStore
      .getState()
      .appendReceived(Array.from({ length: MAX_LOG_ENTRIES * 3 }, (_, i) => message('chatty', String(i))));

    expect(useLogStore.getState().entries.map((e) => e.topic)).toContain('quiet/one');
  });

  // Breadth is not enough on its own: a log that holds one line per topic throws the previous
  // line away every time a new one lands, which is no history at all.
  it('holds a run of history for a topic even when the broker has thousands of them', () => {
    const crowd = Array.from({ length: MAX_LOG_ENTRIES + 500 }, (_, i) => message(`crowd/${i}`, '.'));
    useLogStore.getState().appendReceived(crowd);
    useLogStore
      .getState()
      .appendReceived(Array.from({ length: MIN_TOPIC_ENTRIES }, (_, i) => message('watched', String(i))));

    const mine = useLogStore.getState().entries.filter((e) => e.topic === 'watched');
    expect(mine).toHaveLength(MIN_TOPIC_ENTRIES);
  });

  // The floor is a floor, not a ceiling — one topic alone may have the whole log.
  it('lets a single topic spread out when nothing else is competing for the room', () => {
    const flood = Array.from({ length: MAX_LOG_ENTRIES * 2 }, (_, i) => message('only', String(i)));

    useLogStore.getState().appendReceived(flood);

    expect(useLogStore.getState().entries).toHaveLength(MAX_LOG_ENTRIES);
  });

  it('shares the room out evenly when several topics are all loud', () => {
    const flood = Array.from({ length: MAX_LOG_ENTRIES * 2 }, (_, i) => message(`t/${i % 4}`, String(i)));

    useLogStore.getState().appendReceived(flood);

    const perTopic = new Map<string, number>();
    for (const entry of useLogStore.getState().entries) {
      perTopic.set(entry.topic!, (perTopic.get(entry.topic!) ?? 0) + 1);
    }
    expect([...perTopic.keys()].sort()).toEqual(['t/0', 't/1', 't/2', 't/3']);
    expect(Math.min(...perTopic.values())).toBeGreaterThan(MAX_LOG_ENTRIES / 8);
  });

  it('gives every entry a distinct id', () => {
    useLogStore.getState().push({ kind: 'ok', verb: 'A' });
    useLogStore.getState().push({ kind: 'ok', verb: 'B' });

    const [first, second] = useLogStore.getState().entries;
    expect(first.id).not.toBe(second.id);
  });
});
