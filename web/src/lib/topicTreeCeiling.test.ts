import { describe, expect, it } from 'vitest';
import {
  applyMessages,
  emptyTree,
  evictQuietestTopics,
  MAX_TREE_PAYLOAD,
  quietestTopics,
  type TopicNode,
} from './topicTree';

/**
 * The tree was the only structure in the console without a memory ceiling. Every distinct topic
 * ever seen made a node that lived until the next connection, which is unbounded for a broker
 * whose topic names carry an id — `request/<uuid>/response` is a new node per message.
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

/** A tree of `count` topics, the first ones oldest. */
function grown(count: number): TopicNode {
  let root = emptyTree();
  for (let i = 0; i < count; i++) root = applyMessages(root, [message(`req/${i}`, 1000 + i)], 1000 + i);

  return root;
}

describe('the topics a tree gives up', () => {
  it('picks the ones that have been quiet longest', () => {
    const root = grown(10);

    expect(quietestTopics(root, 3)).toEqual(['req/0', 'req/1', 'req/2']);
  });

  // A selection the reader is looking at would be a pane that went empty under them.
  it('never picks the one the reader is looking at', () => {
    const root = grown(10);

    expect(quietestTopics(root, 3, 'req/0')).toEqual(['req/1', 'req/2', 'req/3']);
  });

  it('leaves a tree inside its ceiling exactly as it was', () => {
    const root = grown(10);

    const { root: after, forgotten } = evictQuietestTopics(root, 50);

    expect(after).toBe(root);
    expect(forgotten).toEqual([]);
  });

  // Down to the ceiling and a tenth further, so the walk is paid once per batch of new topics
  // rather than on every arrival past the cap.
  it('takes a tenth more than it must, so the next arrival does not walk again', () => {
    const root = grown(120);

    const { root: after, forgotten } = evictQuietestTopics(root, 100);

    expect(forgotten).toHaveLength(30);
    expect(after.subTopics).toBe(90);
  });

  it('gives up the quietest and keeps the busiest', () => {
    const root = grown(120);

    const { root: after, forgotten } = evictQuietestTopics(root, 100);

    expect(forgotten).toContain('req/0');
    expect(forgotten).not.toContain('req/119');
    expect(after.subTopics).toBeLessThan(root.subTopics);
  });

  // A branch left with no message of its own and no surviving child goes too, which pruneTopics
  // already does — this is the tree not keeping empty folders after an eviction.
  it('leaves no empty branches behind', () => {
    let root = emptyTree();
    root = applyMessages(root, [message('plant/a/temp', 1000)], 1000);
    root = applyMessages(root, [message('plant/b/temp', 2000)], 2000);

    const { root: after } = evictQuietestTopics(root, 1);

    expect(after.children.get('plant')?.children.has('a')).toBe(false);
    expect(after.subTopics).toBe(1);
  });
});

// The body is the one part of a node with no natural size: fifty thousand topics carrying
// four-kilobyte documents is two hundred megabytes of text held for a row that shows one line.
describe('the body a node keeps', () => {
  const body = (length: number) => 'x'.repeat(length);

  const put = (payload: string) =>
    applyMessages(
      emptyTree(),
      [
        {
          topic: 'lab/big',
          payload,
          mode: 'text' as const,
          qos: 0,
          retain: false,
        },
      ],
      1000,
    );

  it('keeps an ordinary body whole and says it is whole', () => {
    const node = put(body(100)).children.get('lab')?.children.get('big');

    expect(node?.latestPayload).toHaveLength(100);
    expect(node?.latestTruncated).toBe(false);
  });

  it('cuts one past the ceiling and says it cut it', () => {
    const node = put(body(MAX_TREE_PAYLOAD + 5000)).children.get('lab')?.children.get('big');

    expect(node?.latestPayload).toHaveLength(MAX_TREE_PAYLOAD);
    expect(node?.latestTruncated).toBe(true);
  });

  // The boundary itself is whole: a body exactly at the ceiling has nothing missing from it.
  it('keeps a body of exactly the ceiling whole', () => {
    const node = put(body(MAX_TREE_PAYLOAD)).children.get('lab')?.children.get('big');

    expect(node?.latestTruncated).toBe(false);
  });
});
