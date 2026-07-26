import { beforeEach, describe, expect, it } from 'vitest';
import type { MqttMessage } from '../types/api';
import { MAX_LOG_ENTRIES, useLogStore } from './logStore';

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

  it('turns QoS and retain into stamps', () => {
    useLogStore.getState().appendReceived([message('a', '1', { qos: 2, retain: true })]);

    expect(useLogStore.getState().entries[0]).toMatchObject({
      kind: 'recv',
      verb: 'Received',
      topic: 'a',
      body: '1',
      stamps: ['QoS 2', 'RETAINED'],
    });
  });

  it('leaves the retained stamp off when the message is not retained', () => {
    useLogStore.getState().appendReceived([message('a', '1', { qos: 1 })]);

    expect(useLogStore.getState().entries[0].stamps).toEqual(['QoS 1']);
  });

  it('drops the oldest entries past the cap', () => {
    const flood = Array.from({ length: MAX_LOG_ENTRIES + 20 }, (_, i) => message(`t/${i}`, String(i)));

    useLogStore.getState().appendReceived(flood);

    const entries = useLogStore.getState().entries;
    expect(entries).toHaveLength(MAX_LOG_ENTRIES);
    expect(entries[0].topic).toBe(`t/${MAX_LOG_ENTRIES + 19}`);
  });

  it('gives every entry a distinct id', () => {
    useLogStore.getState().push({ kind: 'ok', verb: 'A' });
    useLogStore.getState().push({ kind: 'ok', verb: 'B' });

    const [first, second] = useLogStore.getState().entries;
    expect(first.id).not.toBe(second.id);
  });
});
