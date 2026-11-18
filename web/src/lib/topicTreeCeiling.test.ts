import { describe, expect, it } from 'vitest';
import {
  applyMessages,
  emptyTree,
  evictQuietestTopics,
  MAX_TREE_PAYLOAD,
  pruneTopics,
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

  // What the Manage panel's retained figure is short by. A broker whose topics churn live —
  // Helsinki's carries a geohash in every name — gives up thousands and not one of them retained.
  it('says how many of what it gave up the broker was holding retained', () => {
    let root = emptyTree();
    root = applyMessages(root, [{ ...message('cfg/a', 1000), retain: true }], 1000);
    root = applyMessages(root, [{ ...message('cfg/b', 1001), retain: true, payload: '' }], 1001);
    root = applyMessages(root, [{ ...message('$SYS/up', 1002), retain: true }], 1002);
    root = applyMessages(root, [message('live/a', 1003)], 1003);
    root = applyMessages(root, [message('live/b', 5000)], 5000);

    const { forgotten, retained } = evictQuietestTopics(root, 1);

    // Four went; only cfg/a is one the broker holds — an empty retained body is a clearing, and
    // $SYS is the broker's own, the same two exceptions retainedTopics makes.
    expect(forgotten).toHaveLength(4);
    expect(retained).toBe(1);
  });

  it('counts none retained when nothing it gave up was', () => {
    const { forgotten, retained } = evictQuietestTopics(grown(120), 100);

    expect(forgotten).toHaveLength(30);
    expect(retained).toBe(0);
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

  /*
   * The eviction used to rebuild the tree through pruneTopics, which visits every node to ask
   * whether it goes — near a second at the ceiling, every few seconds on a broker whose topics
   * churn. It now rebuilds only the way down to what it took. These hold it to the tree the old
   * way gave, over the shapes that make a prune hard: a topic that is also a branch, two topics
   * quiet for exactly as long, the reader's own selection, the empty first level and '$'.
   */
  describe('rebuilding only what it took from', () => {
    const mixed = () => {
      const at = [
        ['plant/a', 1000],
        ['plant/a/temp', 1001],
        ['plant/a/flow', 1001],
        ['plant/b/temp', 1002],
        ['plant/b/deep/x/y', 1003],
        ['/hfp/v2/bus/1', 1004],
        ['/hfp/v2/bus/2', 1004],
        ['/hfp/v2/tram/9', 1005],
        ['$SYS/broker/load', 1006],
        ['site/gw', 9000],
        ['site/gw/rssi', 9001],
        ['solo', 9002],
      ] as const;
      let root = emptyTree();
      for (const [topic, when] of at) root = applyMessages(root, [message(topic, when)], when);
      return root;
    };

    // The old way: the same topics, taken by a walk of the whole tree.
    const theOldWay = (root: TopicNode, forgotten: readonly string[]) => {
      const gone = new Set(forgotten);
      return pruneTopics(root, (topic) => gone.has(topic));
    };

    it.each([
      [11, undefined],
      [8, undefined],
      [5, undefined],
      [3, undefined],
      [1, undefined],
      [5, 'plant/a'],
      [5, '/hfp/v2/bus/1'],
    ] as const)('down to %i, keeping %s, gives the tree the old way gave', (ceiling, keep) => {
      const root = mixed();

      const { root: after, forgotten } = evictQuietestTopics(root, ceiling, keep);

      expect(forgotten.length).toBeGreaterThan(0);
      expect(forgotten).toEqual(quietestTopics(root, forgotten.length, keep));
      expect(after).toEqual(theOldWay(root, forgotten));
    });

    it('leaves the branches it took nothing from as the very same nodes', () => {
      const root = mixed();

      const { root: after, forgotten } = evictQuietestTopics(root, 11);

      // One over, and a tenth of the ceiling further: both the oldest, both under plant/a.
      expect(forgotten).toEqual(['plant/a', 'plant/a/temp']);
      expect(after.children.get('site')).toBe(root.children.get('site'));
      expect(after.children.get('')).toBe(root.children.get(''));
      expect(after.children.get('plant')!.children.get('b')).toBe(root.children.get('plant')!.children.get('b'));
    });
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
