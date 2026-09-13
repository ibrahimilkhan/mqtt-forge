import { beforeEach, describe, expect, it } from 'vitest';
import type { DecodedMessage } from '../realtime/decodeIncoming';
import { shownFor, shownWork, useHoldStore } from './holdStore';
import { useLogStore } from './logStore';
import { useTopicTreeStore } from './topicTreeStore';

const message = (topic: string, payload: string): DecodedMessage => ({
  topic,
  payload,
  mode: 'text',
  size: payload.length,
  qos: 0,
  retain: false,
  receivedAt: '2026-09-13T10:00:00Z',
});

/** Into the log and the tree together, the way the hub bridge lands a batch. */
const landed = (...arrivals: Array<[topic: string, payload: string]>) => {
  const messages = arrivals.map(([topic, payload]) => message(topic, payload));
  useLogStore.getState().appendReceived(messages);
  useTopicTreeStore.getState().apply(messages);
};

const bodies = (filter: string) =>
  shownFor(filter).entries.map((entry) => `${entry.topic}=${entry.body}`);

beforeEach(() => {
  useLogStore.getState().clear();
  useTopicTreeStore.getState().reset();
  useHoldStore.getState().release();
});

describe('the hold store', () => {
  it('takes a hold from what the console shows, and lets it go', () => {
    landed(['sensors/temp', '21']);
    useHoldStore.getState().take('sensors/#');
    landed(['sensors/temp', '22']);

    expect(bodies('sensors/#')).toEqual(['sensors/temp=21']);

    useHoldStore.getState().release('sensors/#');

    expect(bodies('sensors/#')).toEqual(['sensors/temp=22', 'sensors/temp=21']);
  });

  it('takes nothing over a filter no row selects', () => {
    landed(['sensors/temp', '21']);

    useHoldStore.getState().take('sensors/+');

    expect(useHoldStore.getState().held.size).toBe(0);
  });

  it('lets every hold go when the tree starts again', () => {
    landed(['sensors/temp', '21']);
    useHoldStore.getState().take('sensors/#');

    useTopicTreeStore.getState().reset();

    expect(useHoldStore.getState().held.size).toBe(0);
  });

  it('trims its holds when topics are forgotten, and lets an emptied one go', () => {
    landed(['sensors/temp', '21'], ['sensors/humidity', '55'], ['plant/kiln', '900']);
    useHoldStore.getState().take('sensors/#');
    useHoldStore.getState().take('plant/#');

    useHoldStore
      .getState()
      .forget((topic) => topic === 'sensors/temp' || topic === 'plant/kiln', 'nothing');

    expect([...useHoldStore.getState().held.keys()]).toEqual(['sensors/#']);
    expect([...useHoldStore.getState().held.get('sensors/#')!.runs.keys()]).toEqual([
      'sensors/humidity',
    ]);
  });
});

describe('the shown view', () => {
  it('is worked out once per change, however often it is asked for', () => {
    landed(['sensors/temp', '21']);
    const before = shownWork.count;

    shownFor('sensors/#');
    shownFor('sensors/#');
    expect(shownWork.count - before).toBe(1);

    landed(['sensors/temp', '22']);
    shownFor('sensors/#');
    expect(shownWork.count - before).toBe(2);
  });

  it('hands back the same runs while nothing it shows has moved', () => {
    landed(['sensors/temp', '21']);
    useHoldStore.getState().take('sensors/#');
    const first = shownFor('sensors/#').runs;

    landed(['plant/kiln', '900']);

    expect(shownFor('sensors/#').runs).toBe(first);
  });
});
