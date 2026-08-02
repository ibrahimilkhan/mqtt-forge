import { describe, expect, it } from 'vitest';
import { applyMessage, applyMessages, emptyTree, nodeSummary, type TopicNode } from './topicTree';

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
    expect(at(tree, 'sensors').subMessages).toBe(2);
  });

  it('rolls sub-counters up to every ancestor', () => {
    let tree = applyMessage(emptyTree(), 'a/b/c', '1', 1000);
    tree = applyMessage(tree, 'a/b/d', '2', 2000);

    expect(at(tree, 'a').subTopics).toBe(2);
    expect(at(tree, 'a').subMessages).toBe(2);
    expect(at(tree, 'a/b').subTopics).toBe(2);
  });

  it('turns a leaf into a branch without losing its own counters', () => {
    let tree = applyMessage(emptyTree(), 'a', 'own', 1000);
    tree = applyMessage(tree, 'a/b', 'child', 2000);

    expect(at(tree, 'a').hits).toBe(1);
    expect(at(tree, 'a').latestPayload).toBe('own');
    expect(at(tree, 'a').subTopics).toBe(2);
    expect(at(tree, 'a').subMessages).toBe(2);
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
    expect(at(tree, 'a').subMessages).toBe(3);
    expect(at(tree, 'a').subTopics).toBe(2);
  });
});
