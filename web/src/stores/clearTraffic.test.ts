import { beforeEach, describe, expect, it } from 'vitest';
import type { DecodedMessage } from '../realtime/decodeIncoming';
import { forgetUnsubscribed } from './clearTraffic';
import { useHoldStore } from './holdStore';
import { useLogStore } from './logStore';
import { useTopicTreeStore } from './topicTreeStore';

const message = (topic: string, payload = '1'): DecodedMessage => ({
  topic,
  payload,
  mode: 'text',
  size: payload.length,
  qos: 0,
  retain: false,
  receivedAt: '2026-07-26T10:00:00Z',
});

/** What the hub bridge does with a batch: the log's runs and the tree, from the same messages. */
const arrive = (...messages: DecodedMessage[]) => {
  useLogStore.getState().appendReceived(messages);
  useTopicTreeStore.getState().apply(messages);
};

beforeEach(() => {
  useTopicTreeStore.getState().reset();
  useLogStore.getState().clear();
  useHoldStore.getState().release();
});

describe('forgetUnsubscribed', () => {
  it('takes the unsubscribed topics out of the tree, and their runs out of the log', () => {
    arrive(message('sensors/temp'), message('devices/a'));

    forgetUnsubscribed('sensors/#', []);

    const root = useTopicTreeStore.getState().root;
    expect(root.children.has('sensors')).toBe(false);
    expect(root.children.has('devices')).toBe(true);
    expect(useLogStore.getState().byTopic.has('sensors/temp')).toBe(false);
    expect(useLogStore.getState().byTopic.has('devices/a')).toBe(true);
  });

  // Still covered by a wider subscription, so messages keep arriving and the rows must stay.
  it('keeps topics another live subscription still covers', () => {
    arrive(message('sensors/temp'));

    forgetUnsubscribed('sensors/#', ['#']);

    expect(useTopicTreeStore.getState().root.children.has('sensors')).toBe(true);
  });

  it('leaves the tree object alone when the filter matched nothing on screen', () => {
    arrive(message('devices/a'));
    const before = useTopicTreeStore.getState().root;

    forgetUnsubscribed('sensors/#', []);

    expect(useTopicTreeStore.getState().root).toBe(before);
  });
});
