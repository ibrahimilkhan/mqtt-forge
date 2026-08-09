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
    // `order` is the display order; the map beside it is a lookup index with no order of its own.
    expect(sensors?.order).toEqual(['humidity', 'temp']);
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

  it('opens the broker row by default, since a lone root row says nothing', () => {
    expect(useTopicTreeStore.getState().brokerOpen).toBe(true);
  });

  it('toggles the broker row on its own', () => {
    useTopicTreeStore.getState().toggleBroker();
    expect(useTopicTreeStore.getState().brokerOpen).toBe(false);

    useTopicTreeStore.getState().toggleBroker();
    expect(useTopicTreeStore.getState().brokerOpen).toBe(true);
  });

  // Collapsing every branch should fold the tree, not empty the pane.
  it('leaves the broker row open when everything is collapsed', () => {
    useTopicTreeStore.getState().setAllOpen(false);

    expect(useTopicTreeStore.getState().brokerOpen).toBe(true);
  });

  it('reopens the broker row on reset, which a fresh connect triggers', () => {
    useTopicTreeStore.getState().toggleBroker();
    useTopicTreeStore.getState().reset();

    expect(useTopicTreeStore.getState().brokerOpen).toBe(true);
  });
});

describe('dropFilter', () => {
  it('takes the unsubscribed topics out of the tree', () => {
    useTopicTreeStore.getState().apply([message('sensors/temp'), message('devices/a')]);

    useTopicTreeStore.getState().dropFilter('sensors/#', []);

    const root = useTopicTreeStore.getState().root;
    expect(root.children.has('sensors')).toBe(false);
    expect(root.children.has('devices')).toBe(true);
  });

  // Still covered by a wider subscription, so messages keep arriving and the rows must stay.
  it('keeps topics another live subscription still covers', () => {
    useTopicTreeStore.getState().apply([message('sensors/temp')]);

    useTopicTreeStore.getState().dropFilter('sensors/#', ['#']);

    expect(useTopicTreeStore.getState().root.children.has('sensors')).toBe(true);
  });

  it('leaves the tree object alone when the filter matched nothing on screen', () => {
    useTopicTreeStore.getState().apply([message('devices/a')]);
    const before = useTopicTreeStore.getState().root;

    useTopicTreeStore.getState().dropFilter('sensors/#', []);

    expect(useTopicTreeStore.getState().root).toBe(before);
  });
});
