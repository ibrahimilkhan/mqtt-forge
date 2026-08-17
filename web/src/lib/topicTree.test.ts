import { describe, expect, it } from 'vitest';
import {
  applyMessage,
  applyMessages,
  emptyTree,
  flattenTree,
  nodeSummary,
  pruneTopics,
  type TopicNode,
} from './topicTree';
import { matchesFilter } from './topicMatch';

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

// A whole broker can be scanned for what is moving only if the rows carry the movement. The
// tree keeps a short run per topic for that, which is not the log — it is bounded, and it holds
// numbers rather than messages.
describe('the run a topic keeps for its sparkline', () => {
  const run = (tree: TopicNode, path: string) => at(tree, path).readings;

  it('keeps the numbers a topic has sent, oldest first', () => {
    let tree = emptyTree();
    for (const value of ['21.5', '22', '20.75']) {
      tree = applyMessage(tree, 'sensors/temp', value, 1000);
    }

    expect(run(tree, 'sensors/temp')).toEqual([21.5, 22, 20.75]);
  });

  it('keeps nothing for a topic whose payloads are not numbers', () => {
    const tree = applyMessage(applyMessage(emptyTree(), 'sensors/state', 'ON', 1), 'sensors/state', 'OFF', 2);

    expect(run(tree, 'sensors/state')).toEqual([]);
  });

  it('steps over a message it cannot read without losing the run', () => {
    let tree = emptyTree();
    for (const value of ['21.5', 'warming up', '22']) {
      tree = applyMessage(tree, 'sensors/temp', value, 1000);
    }

    expect(run(tree, 'sensors/temp')).toEqual([21.5, 22]);
  });

  // A tree row is a thumbnail, not a chart: the pane below holds the history, and a tree of
  // thousands of topics each keeping thousands of readings is a tree that eats the browser.
  it('holds a short run and drops the oldest past it', () => {
    let tree = emptyTree();
    for (let i = 0; i < 40; i++) tree = applyMessage(tree, 'sensors/temp', String(i), 1000);

    const readings = run(tree, 'sensors/temp');
    expect(readings.length).toBeLessThanOrEqual(24);
    expect(readings[readings.length - 1]).toBe(39);
  });

  it('gives a binary payload no reading, whatever its hex would parse as', () => {
    const tree = applyMessage(emptyTree(), 'sensors/raw', '10', 1000, 0, false, 'hex');

    expect(run(tree, 'sensors/raw')).toEqual([]);
  });

  // A branch's own row shows what is beneath it, and its children's readings are not its own.
  it('keeps a run only on the topic the message landed on', () => {
    const tree = applyMessage(emptyTree(), 'sensors/room/temp', '21.5', 1000);

    expect(run(tree, 'sensors')).toEqual([]);
    expect(run(tree, 'sensors/room/temp')).toEqual([21.5]);
  });
});

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

  it('counts messages beneath a node, not just topics', () => {
    let tree = applyMessage(emptyTree(), 'a/b', '1', 1000);
    tree = applyMessage(tree, 'a/b', '2', 2000);
    tree = applyMessage(tree, 'a/c', '3', 3000);

    expect(at(tree, 'a').subMessages).toBe(3);
    expect(at(tree, 'a').subTopics).toBe(2);
    expect(at(tree, 'a/b').subMessages).toBe(2);
  });

  // What the broker row reports: everything the console has taken in, at a glance.
  it('totals every message and topic at the root', () => {
    let tree = applyMessage(emptyTree(), 'a/b', '1', 1000);
    tree = applyMessage(tree, 'x/y/z', '2', 2000);
    tree = applyMessage(tree, 'a/b', '3', 3000);

    expect(tree.subMessages).toBe(3);
    expect(tree.subTopics).toBe(2);
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
    expect(nodeSummary(at(tree, 'a'))).toBe('2 topics · 2 messages');
  });

  // Display order lives on `order`, not in the map's own iteration order, and the repeat path
  // touches neither — so ordering has to hold through repeats, not just first sightings.
  it('keeps siblings alphabetical through a stream of repeats', () => {
    let tree = applyMessage(emptyTree(), 'sensors/zeta', '1', 1000);
    tree = applyMessage(tree, 'sensors/alpha', '1', 1000);
    tree = applyMessage(tree, 'sensors/mid', '1', 1000);

    for (const name of ['mid', 'zeta', 'alpha', 'mid', 'zeta']) {
      tree = applyMessage(tree, `sensors/${name}`, '2', 2000);
    }

    expect(at(tree, 'sensors').order).toEqual(['alpha', 'mid', 'zeta']);
    expect(at(tree, 'sensors/mid').hits).toBe(3);
  });

  // What React actually keys on. The child map underneath is an index, not an identity, so the
  // nodes have to be captured before the message lands rather than walked out of the old tree.
  it('gives every node on the message path a new object, so memoised rows notice', () => {
    const first = applyMessage(emptyTree(), 'a/b/c', '1', 1000);
    const before = { a: at(first, 'a'), b: at(first, 'a/b'), c: at(first, 'a/b/c') };

    const second = applyMessage(first, 'a/b/c', '2', 2000);

    expect(second).not.toBe(first);
    expect(at(second, 'a')).not.toBe(before.a);
    expect(at(second, 'a/b')).not.toBe(before.b);
    expect(at(second, 'a/b/c')).not.toBe(before.c);
  });

  // The price of updating child maps in place, stated plainly so nobody stores a root and
  // expects it to keep saying what the tree looked like at the time.
  it('does not leave the previous root usable as a snapshot', () => {
    const first = applyMessage(emptyTree(), 'a/b', 'one', 1000);

    applyMessage(first, 'a/b', 'two', 2000);

    expect(at(first, 'a/b').latestPayload).toBe('two');
  });

  it('keeps siblings alphabetical whatever order they arrive in', () => {
    let tree = applyMessage(emptyTree(), 'sensors/zeta', '1', 1000);
    tree = applyMessage(tree, 'sensors/alpha', '2', 2000);
    tree = applyMessage(tree, 'sensors/mid', '3', 3000);

    expect(at(tree, 'sensors').order).toEqual(['alpha', 'mid', 'zeta']);
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
    // Held before the next message, since walking the old root afterwards would find the new node.
    const untouched = at(first, 'a');

    const second = applyMessage(first, 'b/change', '2', 2000);

    expect(at(second, 'a')).toBe(untouched);
  });
});

describe('nodeSummary', () => {
  it('shows nothing on a leaf, however many times it has been hit', () => {
    const once = applyMessage(emptyTree(), 'a', '1', 1000);
    expect(nodeSummary(at(once, 'a'))).toBe('');

    const twice = applyMessage(once, 'a', '2', 2000);
    expect(nodeSummary(at(twice, 'a'))).toBe('');
  });

  it('shows the topic and message counts on a branch, pluralised', () => {
    let tree = applyMessage(emptyTree(), 'a/b', '1', 1000);
    expect(nodeSummary(at(tree, 'a'))).toBe('1 topic · 1 message');

    tree = applyMessage(tree, 'a/c', '2', 2000);
    tree = applyMessage(tree, 'a/c', '3', 3000);
    expect(nodeSummary(at(tree, 'a'))).toBe('2 topics · 3 messages');
  });

  // Six figures of traffic is normal on a public broker and unreadable without them.
  it('groups the thousands so a big count can be read', () => {
    const many = Array.from({ length: 1500 }, (_, i) => ({ topic: `t${i}`, payload: '1' }));

    expect(nodeSummary(applyMessages(emptyTree(), many, 1000))).toBe(
      '1,500 topics · 1,500 messages',
    );
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

  it('remembers how the last message on a topic was written', () => {
    const tree = applyMessages(
      emptyTree(),
      [{ topic: 'device/cmd', payload: '01 A4 FF', mode: 'hex', qos: 0, retain: false }],
      0,
    );

    expect(tree.children.get('device')!.children.get('cmd')!.latestMode).toBe('hex');
  });

  it('calls a message with no mode text', () => {
    const tree = applyMessages(emptyTree(), [{ topic: 'sensors/temp', payload: '23.5' }], 0);

    expect(tree.children.get('sensors')!.children.get('temp')!.latestMode).toBe('text');
  });
});

describe('pruneTopics', () => {
  const build = (...topics: string[]) =>
    applyMessages(emptyTree(), topics.map((topic) => ({ topic, payload: '1' })), 1000);

  it('removes the topics it is told to, and the branches left empty behind them', () => {
    const tree = pruneTopics(build('sensors/room/temp', 'devices/a/state'), (topic) =>
      matchesFilter('sensors/#', topic),
    );

    expect(tree.children.has('sensors')).toBe(false);
    expect(at(tree, 'devices/a/state').hits).toBe(1);
  });

  it('keeps a branch that still has a surviving child under it', () => {
    const tree = pruneTopics(build('sensors/room/temp', 'sensors/room/humidity'), (topic) =>
      matchesFilter('sensors/room/temp', topic),
    );

    expect(at(tree, 'sensors/room').order).toEqual(['humidity']);
  });

  it('re-counts the topics and messages above what it took out', () => {
    let tree = build('a/x', 'a/y');
    tree = applyMessages(tree, [{ topic: 'a/y', payload: '2' }], 2000);

    tree = pruneTopics(tree, (topic) => topic === 'a/y');

    expect(at(tree, 'a').subTopics).toBe(1);
    expect(at(tree, 'a').subMessages).toBe(1);
    expect(tree.subMessages).toBe(1);
  });

  // A branch that lost nothing must come back identical, or every memoised row re-renders.
  it('hands back untouched branches as the very same node', () => {
    const tree = build('a/x', 'b/y');
    const before = at(tree, 'b');

    const pruned = pruneTopics(tree, (topic) => topic === 'a/x');

    expect(at(pruned, 'b')).toBe(before);
    expect(pruned).not.toBe(tree);
  });

  it('leaves the tree alone when nothing matches', () => {
    const tree = build('a/x');

    expect(pruneTopics(tree, () => false)).toBe(tree);
  });

  // A parent that carries its own message is not a folder — it stays, minus that message.
  it('empties a node that has children of its own but keeps the branch', () => {
    const tree = pruneTopics(build('a', 'a/x'), (topic) => topic === 'a');

    expect(at(tree, 'a').hits).toBe(0);
    expect(at(tree, 'a').latestPayload).toBe(null);
    expect(at(tree, 'a/x').hits).toBe(1);
    expect(at(tree, 'a').subTopics).toBe(1);
  });

  it('drops the mode along with the payload when a node keeps its branch but loses its own message', () => {
    const tree = pruneTopics(
      applyMessages(
        emptyTree(),
        [
          { topic: 'a', payload: '01 A4', mode: 'hex' },
          { topic: 'a/x', payload: '1' },
        ],
        1000,
      ),
      (topic) => topic === 'a',
    );

    expect(at(tree, 'a').latestPayload).toBe(null);
    expect(at(tree, 'a').latestMode).toBe(null);
  });

  it('keeps the mode when a node keeps its own message', () => {
    const tree = pruneTopics(
      applyMessages(
        emptyTree(),
        [
          { topic: 'a', payload: '01 A4', mode: 'hex' },
          { topic: 'a/x', payload: '1' },
        ],
        1000,
      ),
      (topic) => topic === 'a/x',
    );

    expect(at(tree, 'a').latestPayload).toBe('01 A4');
    expect(at(tree, 'a').latestMode).toBe('hex');
  });

  // Twenty thousand segments is the point of it, and building that tree costs over a second
  // here and several on a CI runner — past vitest's five-second default. A regression here
  // overflows the stack rather than running slowly, so the budget can be generous.
  it('survives a topic deep enough to overflow a recursive walk', () => {
    const deep = Array.from({ length: 20000 }, (_, i) => `s${i}`).join('/');
    const tree = pruneTopics(build(deep, 'keep/me'), (topic) => topic.startsWith('s0'));

    expect(tree.children.has('s0')).toBe(false);
    expect(at(tree, 'keep/me').hits).toBe(1);
  }, 30_000);
});
