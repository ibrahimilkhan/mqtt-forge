import { describe, expect, it } from 'vitest';
import {
  applyMessage,
  applyMessages,
  emptyTree,
  flattenTree,
  nodeSummary,
  type TopicNode,
} from './topicTree';

// Walks a slash-separated path and fails loudly if it is missing, so assertions read flat.
function at(root: TopicNode, path: string): TopicNode {
  let node = root;
  for (const segment of path.split('/')) {
    const child = node.children.get(segment);
    if (!child) throw new Error(`no node at ${path}`);
    node = child;
  }
  return node;
}

describe('applyMessage', () => {
  it('creates a node per topic segment and records the payload on the leaf', () => {
    const tree = applyMessage(emptyTree(), 'sensors/room/temp', '21.5', 1000);

    expect(at(tree, 'sensors/room/temp').latestPayload).toBe('21.5');
    expect(at(tree, 'sensors/room/temp').hits).toBe(1);
    expect(at(tree, 'sensors/room/temp').lastHitAt).toBe(1000);
  });

  it('counts a repeat on the same topic as a message but not as a new topic', () => {
    let tree = applyMessage(emptyTree(), 'sensors/temp', '21.5', 1000);
    tree = applyMessage(tree, 'sensors/temp', '22.0', 2000);

    expect(at(tree, 'sensors/temp').hits).toBe(2);
    expect(at(tree, 'sensors/temp').latestPayload).toBe('22.0');
    expect(at(tree, 'sensors').subTopics).toBe(1);
  });

  it('rolls sub-counters up to every ancestor', () => {
    let tree = applyMessage(emptyTree(), 'a/b/c', '1', 1000);
    tree = applyMessage(tree, 'a/b/d', '2', 2000);

    expect(at(tree, 'a').subTopics).toBe(2);
    expect(at(tree, 'a/b').subTopics).toBe(2);
  });

  it('turns a leaf into a branch without losing its own counters', () => {
    let tree = applyMessage(emptyTree(), 'a', 'own', 1000);
    tree = applyMessage(tree, 'a/b', 'child', 2000);

    expect(at(tree, 'a').hits).toBe(1);
    expect(at(tree, 'a').latestPayload).toBe('own');
    expect(at(tree, 'a').subTopics).toBe(2);
    expect(nodeSummary(at(tree, 'a'))).toBe('2 topics');
  });

  it('keeps siblings alphabetical whatever order they arrive in', () => {
    let tree = applyMessage(emptyTree(), 'sensors/zeta', '1', 1000);
    tree = applyMessage(tree, 'sensors/alpha', '2', 2000);
    tree = applyMessage(tree, 'sensors/mid', '3', 3000);

    expect([...at(tree, 'sensors').children.keys()]).toEqual(['alpha', 'mid', 'zeta']);
  });

  it('stamps every ancestor with the time of the newest message in its subtree', () => {
    const tree = applyMessage(emptyTree(), 'a/b/c', '1', 7000);

    expect(at(tree, 'a').lastSubHitAt).toBe(7000);
    expect(at(tree, 'a/b').lastSubHitAt).toBe(7000);
    expect(at(tree, 'a/b/c').lastHitAt).toBe(7000);
  });

  it('leaves the subtree stamp of an untouched sibling alone', () => {
    let tree = applyMessage(emptyTree(), 'a/x', '1', 1000);
    tree = applyMessage(tree, 'b/y', '2', 2000);

    expect(at(tree, 'a').lastSubHitAt).toBe(1000);
    expect(at(tree, 'b').lastSubHitAt).toBe(2000);
  });

  it('leaves untouched branches identical, so memoised rows can skip re-rendering', () => {
    const first = applyMessage(emptyTree(), 'a/keep', '1', 1000);
    const second = applyMessage(first, 'b/change', '2', 2000);

    expect(at(second, 'a')).toBe(at(first, 'a'));
  });
});

describe('nodeSummary', () => {
  it('shows nothing on a leaf, however many times it has been hit', () => {
    const once = applyMessage(emptyTree(), 'a', '1', 1000);
    expect(nodeSummary(at(once, 'a'))).toBe('');

    const twice = applyMessage(once, 'a', '2', 2000);
    expect(nodeSummary(at(twice, 'a'))).toBe('');
  });

  it('shows a topic count on a branch, pluralised', () => {
    let tree = applyMessage(emptyTree(), 'a/b', '1', 1000);
    expect(nodeSummary(at(tree, 'a'))).toBe('1 topic');

    tree = applyMessage(tree, 'a/c', '2', 2000);
    expect(nodeSummary(at(tree, 'a'))).toBe('2 topics');
  });
});

describe('a pathologically deep topic', () => {
  it('does not overflow the stack on a topic with thousands of segments', () => {
    const topic = Array.from({ length: 8000 }, (_, i) => `s${i}`).join('/');

    const tree = applyMessage(emptyTree(), topic, 'x', 1000);

    expect(at(tree, topic).latestPayload).toBe('x');
  });
});

describe('flattenTree', () => {
  const allClosed = () => false;
  const allOpen = () => true;
  const paths = (rows: ReadonlyArray<{ path: string }>) => rows.map((row) => row.path);

  const tree = (...topics: string[]) =>
    applyMessages(
      emptyTree(),
      topics.map((topic) => ({ topic, payload: '1' })),
      1000,
    );

  it('stops at the top level while every branch is closed', () => {
    const { rows } = flattenTree(tree('sensors/room/temp', 'lights/hall'), allClosed, 100);

    expect(paths(rows)).toEqual(['lights', 'sensors']);
  });

  it('walks into a branch the caller reports as open', () => {
    const isOpen = (path: string) => path === 'sensors';

    const { rows } = flattenTree(tree('sensors/room/temp', 'sensors/humidity'), isOpen, 100);

    expect(paths(rows)).toEqual(['sensors', 'sensors/humidity', 'sensors/room']);
  });

  it('lists a subtree depth-first, in the order the rows are drawn', () => {
    const { rows } = flattenTree(tree('a/x/1', 'a/y', 'b'), allOpen, 100);

    expect(paths(rows)).toEqual(['a', 'a/x', 'a/x/1', 'a/y', 'b']);
  });

  it('reports the depth and kind of each row', () => {
    const { rows } = flattenTree(tree('a/b'), allOpen, 100);

    expect(rows.map((row) => [row.depth, row.isBranch])).toEqual([
      [0, true],
      [1, false],
    ]);
  });

  it('passes the open flag through, so a row can draw its own twisty', () => {
    const { rows } = flattenTree(tree('a/b'), (path) => path === 'a', 100);

    expect(rows.map((row) => row.open)).toEqual([true, false]);
  });

  it('stops at the limit and counts what it left out', () => {
    const { rows, hidden } = flattenTree(tree('a', 'b', 'c', 'd', 'e'), allOpen, 2);

    expect(paths(rows)).toEqual(['a', 'b']);
    expect(hidden).toBe(3);
  });

  it('counts nothing as hidden when the whole visible tree fits', () => {
    const { hidden } = flattenTree(tree('a', 'b'), allOpen, 100);

    expect(hidden).toBe(0);
  });

  it('does not overflow the stack on a topic with thousands of segments', () => {
    const topic = Array.from({ length: 8000 }, (_, i) => `s${i}`).join('/');

    const { rows } = flattenTree(applyMessage(emptyTree(), topic, 'x', 1000), allOpen, 10_000);

    expect(rows).toHaveLength(8000);
  });
});

describe('applyMessages', () => {
  it('applies a whole batch in order', () => {
    const tree = applyMessages(
      emptyTree(),
      [
        { topic: 'a/b', payload: '1' },
        { topic: 'a/b', payload: '2' },
        { topic: 'a/c', payload: '3' },
      ],
      5000,
    );

    expect(at(tree, 'a/b').latestPayload).toBe('2');
    expect(at(tree, 'a').subTopics).toBe(2);
  });
});
