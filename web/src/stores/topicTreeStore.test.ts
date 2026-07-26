import { beforeEach, describe, expect, it } from 'vitest';
import type { MqttMessage } from '../types/api';
import { isPathOpen, useTopicTreeStore } from './topicTreeStore';

const message = (topic: string, payload = '1'): MqttMessage => ({
  topic,
  payload,
  qos: 0,
  retain: false,
  receivedAt: '2026-07-26T10:00:00Z',
});

beforeEach(() => {
  useTopicTreeStore.setState({ defaultOpen: false });
  useTopicTreeStore.getState().reset();
});

describe('topicTreeStore', () => {
  it('builds the tree from a batch', () => {
    useTopicTreeStore.getState().apply([message('sensors/temp'), message('sensors/humidity')]);

    const sensors = useTopicTreeStore.getState().root.children.get('sensors');
    expect([...(sensors?.children.keys() ?? [])]).toEqual(['humidity', 'temp']);
  });

  it('starts every branch collapsed, as the old console did', () => {
    useTopicTreeStore.getState().apply([message('sensors/temp')]);

    expect(isPathOpen(useTopicTreeStore.getState(), 'sensors')).toBe(false);
  });

  it('toggles a single path without touching its siblings', () => {
    useTopicTreeStore.getState().apply([message('a/x'), message('b/y')]);

    useTopicTreeStore.getState().toggle('a');

    expect(isPathOpen(useTopicTreeStore.getState(), 'a')).toBe(true);
    expect(isPathOpen(useTopicTreeStore.getState(), 'b')).toBe(false);
  });

  it('applies expand-all to branches that arrive afterwards', () => {
    useTopicTreeStore.getState().apply([message('a/x')]);

    useTopicTreeStore.getState().setAllOpen(true);
    useTopicTreeStore.getState().apply([message('b/y')]);

    expect(isPathOpen(useTopicTreeStore.getState(), 'a')).toBe(true);
    expect(isPathOpen(useTopicTreeStore.getState(), 'b')).toBe(true);
  });

  it('clears per-path choices when everything is collapsed', () => {
    useTopicTreeStore.getState().apply([message('a/x')]);
    useTopicTreeStore.getState().toggle('a');

    useTopicTreeStore.getState().setAllOpen(false);

    expect(isPathOpen(useTopicTreeStore.getState(), 'a')).toBe(false);
  });

  it('empties the tree on reset, which a fresh connect triggers', () => {
    useTopicTreeStore.getState().apply([message('a/x')]);

    useTopicTreeStore.getState().reset();

    expect(useTopicTreeStore.getState().root.children.size).toBe(0);
  });
});
