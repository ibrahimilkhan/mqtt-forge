import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_TREE_TOPICS } from '../lib/topicTree';
import { useLogStore } from './logStore';
import { useSelectionStore } from './selectionStore';
import { useTopicTreeStore } from './topicTreeStore';

/**
 * The tree and the log hold one thing between them — a topic's row and that topic's readings —
 * so a topic the tree gives up has to leave the log with it. A row whose click shows nothing, or
 * a run of readings nothing on screen can reach, is worse than either being gone.
 */
const message = (topic: string, at: number) => ({
  topic,
  payload: '1',
  mode: 'text' as const,
  size: 1,
  qos: 0,
  retain: false,
  receivedAt: new Date(at).toISOString(),
});

describe('a tree at its ceiling', () => {
  beforeEach(() => {
    useTopicTreeStore.getState().reset();
    useLogStore.getState().clear();
    useSelectionStore.getState().clear();
  });

  it('says how many topics it has forgotten', () => {
    // One batch past the ceiling, which is the cheapest way to reach it: the walk is paid once.
    const many = Array.from({ length: MAX_TREE_TOPICS + 2000 }, (_, i) => message(`req/${i}`, 1000 + i));
    useTopicTreeStore.getState().apply(many);

    const { root, forgotten } = useTopicTreeStore.getState();

    expect(root.subTopics).toBeLessThanOrEqual(MAX_TREE_TOPICS);
    expect(forgotten).toBeGreaterThan(0);
    expect(root.subTopics + forgotten).toBe(MAX_TREE_TOPICS + 2000);
  });

  it('takes the forgotten topics out of the log as well', () => {
    // Two batches, because a batch is one moment: within it every topic is as quiet as every
    // other, and it is the batch before that is the older one.
    const batch = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, i) => message(`req/${from + i}`, 1000 + from + i));

    const first = batch(0, 1000);
    useLogStore.getState().appendReceived(first);
    useTopicTreeStore.getState().apply(first);

    const rest = batch(1000, MAX_TREE_TOPICS + 2000);
    useLogStore.getState().appendReceived(rest);
    useTopicTreeStore.getState().apply(rest);

    // The oldest batch went first, and neither structure is left holding what the other dropped.
    expect(useTopicTreeStore.getState().root.children.get('req')?.children.has('0')).toBe(false);
    expect(useLogStore.getState().byTopic.has('req/0')).toBe(false);
    expect(useLogStore.getState().byTopic.size).toBe(useTopicTreeStore.getState().root.subTopics);
  });

  it('starts the count again with the tree', () => {
    useTopicTreeStore
      .getState()
      .apply(Array.from({ length: MAX_TREE_TOPICS + 2000 }, (_, i) => message(`req/${i}`, 1000 + i)));
    expect(useTopicTreeStore.getState().forgotten).toBeGreaterThan(0);

    useTopicTreeStore.getState().reset();

    expect(useTopicTreeStore.getState().forgotten).toBe(0);
  });
});
