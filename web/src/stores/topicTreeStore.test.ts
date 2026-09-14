import { beforeEach, describe, expect, it } from 'vitest';
import type { DecodedMessage } from '../realtime/decodeIncoming';
import { isPathOpen, useTopicTreeStore } from './topicTreeStore';

const message = (topic: string, payload = '1'): DecodedMessage => ({
  topic,
  payload,
  mode: 'text',
  size: payload.length,
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

  it('reopens the broker row on reset, which a fresh connect triggers', () => {
    useTopicTreeStore.getState().toggleBroker();
    useTopicTreeStore.getState().reset();

    expect(useTopicTreeStore.getState().brokerOpen).toBe(true);
  });
});

// The broker row is what everything hangs off, so both controls have to reach it: with it left
// out, expanding opened every branch behind a closed door and collapsing left the top level
// standing. The row itself is always drawn, so folding it puts the tree away without emptying
// the pane.
describe('setAllOpen and the broker row', () => {
  it('opens the broker row, so expanding everything shows something', () => {
    useTopicTreeStore.setState({ brokerOpen: false });

    useTopicTreeStore.getState().setAllOpen(true);

    expect(useTopicTreeStore.getState().brokerOpen).toBe(true);
  });

  it('leaves an already open broker row open', () => {
    useTopicTreeStore.setState({ brokerOpen: true });

    useTopicTreeStore.getState().setAllOpen(true);

    expect(useTopicTreeStore.getState().brokerOpen).toBe(true);
  });

  it('folds the broker row when everything collapses', () => {
    useTopicTreeStore.setState({ brokerOpen: true });

    useTopicTreeStore.getState().setAllOpen(false);

    expect(useTopicTreeStore.getState().brokerOpen).toBe(false);
  });

  it('leaves an already folded broker row folded', () => {
    useTopicTreeStore.setState({ brokerOpen: false });

    useTopicTreeStore.getState().setAllOpen(false);

    expect(useTopicTreeStore.getState().brokerOpen).toBe(false);
  });
});

describe('the empty first level', () => {
  it('expands the branch under / and nothing beside it', () => {
    useTopicTreeStore.getState().apply([message('/hfp/v2/bus'), message('plant/kiln')]);

    useTopicTreeStore.getState().setAllOpen(true, '');

    const state = useTopicTreeStore.getState();
    expect(state.defaultOpen).toBe(false);
    expect(isPathOpen(state, '')).toBe(true);
    expect(isPathOpen(state, '/hfp')).toBe(true);
    expect(isPathOpen(state, '/hfp/v2')).toBe(true);
    expect(isPathOpen(state, 'plant')).toBe(false);
  });
});

describe('dropTopics', () => {
  it('takes whatever the test says out of the tree, $SYS included', () => {
    useTopicTreeStore.getState().apply([message('$SYS/broker/uptime'), message('sensors/temp')]);

    useTopicTreeStore.getState().dropTopics((topic) => topic.startsWith('$SYS'));

    expect(useTopicTreeStore.getState().root.order).toEqual(['sensors']);
  });
});

describe('a link that came back', () => {
  it('is marked when it came back, and forgotten when the tree starts again', () => {
    useTopicTreeStore.getState().returned(5000);
    expect(useTopicTreeStore.getState().returnedAt).toBe(5000);

    useTopicTreeStore.getState().reset();
    expect(useTopicTreeStore.getState().returnedAt).toBeNull();
  });
});
