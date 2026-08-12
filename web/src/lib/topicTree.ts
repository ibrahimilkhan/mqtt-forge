import type { BodyMode } from './payload';

export type TopicNode = {
  name: string;
  /** Lookup index, keyed by segment. Its own iteration order means nothing — `order` has that. */
  children: ReadonlyMap<string, TopicNode>;
  /** Child names, alphabetical. Held apart from the map so a new sibling is a splice into an
   *  array of strings rather than a rebuild of a map of thousands. */
  order: readonly string[];
  latestPayload: string | null;
  latestMode: BodyMode | null;  // how latestPayload is written; null means no message of its own,
                                 // so a click must leave the publish form's mode untouched
  latestQos: number;     // settings of the last message on this exact topic, for re-publishing it
  latestRetain: boolean;
  hits: number;          // messages delivered directly to this topic
  subTopics: number;     // topics at or beneath it with a message
  subMessages: number;   // messages delivered at or beneath it
  lastHitAt: number;     // last message on this exact topic
  lastSubHitAt: number;  // last message at or beneath it; drives the flash
};

export const emptyTree = (): TopicNode => leaf('');

const leaf = (name: string): TopicNode => ({
  name,
  children: new Map(),
  order: [],
  latestPayload: null,
  latestMode: null,
  latestQos: 0,
  latestRetain: false,
  hits: 0,
  subTopics: 0,
  subMessages: 0,
  lastHitAt: 0,
  lastSubHitAt: 0,
});

/** What the tree needs off a message. QoS and retain ride along so a click can re-publish it. */
type TreeMessage = {
  topic: string;
  payload: string;
  mode?: BodyMode;
  qos?: number;
  retain?: boolean;
};

export function applyMessage(
  root: TopicNode,
  topic: string,
  payload: string,
  at: number,
  qos = 0,
  retain = false,
  mode: BodyMode = 'text',
): TopicNode {
  return insert(root, topic.split('/'), payload, at, qos, retain, mode).node;
}

export function applyMessages(
  root: TopicNode,
  messages: ReadonlyArray<TreeMessage>,
  at: number,
): TopicNode {
  return messages.reduce(
    (tree, m) => applyMessage(tree, m.topic, m.payload, at, m.qos ?? 0, m.retain ?? false, m.mode ?? 'text'),
    root,
  );
}

/**
 * Drops every topic `remove` says yes to, and rebuilds the counts above them. A branch left with
 * no message of its own and no surviving child goes too, so unsubscribing does not leave a trail
 * of empty folders behind.
 *
 * Branches nothing was taken out of come back as the very same node, which is what keeps the
 * memoised rows from re-rendering the whole pane over one removed filter.
 *
 * Iterative post-order, matching insert(): a deep topic must not overflow the stack.
 */
export function pruneTopics(root: TopicNode, remove: (topic: string) => boolean): TopicNode {
  type Frame = {
    node: TopicNode;
    path: string;
    index: number;
    kept: Map<string, TopicNode>;
    order: string[];
  };

  const frame = (node: TopicNode, path: string): Frame => ({
    node,
    path,
    index: 0,
    kept: new Map(),
    order: [],
  });

  const stack: Frame[] = [frame(root, '')];
  // undefined means 'no child has just finished'; null means the child that did was dropped.
  let finished: TopicNode | null | undefined = undefined;

  while (stack.length > 0) {
    const current = stack[stack.length - 1];

    if (finished !== undefined) {
      const name = current.node.order[current.index];
      if (finished !== null) {
        current.kept.set(name, finished);
        current.order.push(name);
      }
      current.index++;
      finished = undefined;
    }

    if (current.index < current.node.order.length) {
      const name = current.node.order[current.index];
      const child = current.node.children.get(name)!;
      stack.push(frame(child, current.path ? `${current.path}/${name}` : name));
      continue;
    }

    stack.pop();
    finished = rebuild(current.node, current.path, current.kept, current.order, remove);
  }

  // The root is never a topic, so it survives whatever happens beneath it.
  return finished ?? emptyTree();
}

function rebuild(
  node: TopicNode,
  path: string,
  kept: Map<string, TopicNode>,
  order: string[],
  remove: (topic: string) => boolean,
): TopicNode | null {
  const dropped = path !== '' && remove(path);
  const survived =
    !dropped &&
    order.length === node.order.length &&
    order.every((name) => kept.get(name) === node.children.get(name));

  if (survived) return node;

  // Nothing of its own left and nothing underneath: the branch itself is gone. Not the root,
  // which has to hand back a tree even when it is empty.
  if (path !== '' && order.length === 0 && (dropped || node.hits === 0)) return null;

  let subTopics = dropped || node.hits === 0 ? 0 : 1;
  let subMessages = dropped ? 0 : node.hits;
  let lastSubHitAt = dropped ? 0 : node.lastHitAt;

  for (const name of order) {
    const child = kept.get(name)!;
    subTopics += child.subTopics;
    subMessages += child.subMessages;
    lastSubHitAt = Math.max(lastSubHitAt, child.lastSubHitAt);
  }

  return {
    ...node,
    children: kept,
    order,
    latestPayload: dropped ? null : node.latestPayload,
    latestQos: dropped ? 0 : node.latestQos,
    latestRetain: dropped ? false : node.latestRetain,
    hits: dropped ? 0 : node.hits,
    lastHitAt: dropped ? 0 : node.lastHitAt,
    subTopics,
    subMessages,
    lastSubHitAt,
  };
}

// One drawable row. A closed branch contributes a row but none of its descendants.
export type TopicRow = {
  path: string;
  node: TopicNode;
  depth: number;
  isBranch: boolean;
  open: boolean;
};

// The rows a busy broker's tree is allowed to put on screen at once; the rest are counted
// and left out. A '#' subscription can otherwise reach tens of thousands of topics.
export const MAX_TREE_ROWS = 1500;

// Flattens the visible part of the tree so rendering never walks a closed subtree.
// Iterative, matching insert() — deep topics would overflow a recursive walk.
export function flattenTree(
  root: TopicNode,
  isOpen: (path: string) => boolean,
  limit: number,
): { rows: TopicRow[]; hidden: number } {
  const rows: TopicRow[] = [];
  let hidden = 0;

  // Reverse order in, so popping walks siblings alphabetically.
  const stack: TopicRow[] = [];
  const descend = (node: TopicNode, path: string, depth: number) => {
    const { order, children } = node;
    for (let i = order.length - 1; i >= 0; i--) {
      const child = children.get(order[i])!;
      stack.push({
        node: child,
        path: path ? `${path}/${child.name}` : child.name,
        depth,
        isBranch: child.children.size > 0,
        open: false,
      });
    }
  };

  descend(root, '', 0);

  while (stack.length > 0) {
    const row = stack.pop()!;
    row.open = row.isBranch && isOpen(row.path);

    if (rows.length < limit) rows.push(row);
    else hidden++;

    if (row.open) descend(row.node, row.path, row.depth + 1);
  }

  return { rows, hidden };
}

// What a branch is carrying; nothing for leaves, whose own payload is on the row already.
export function nodeSummary(node: TopicNode): string {
  if (node.children.size === 0) return '';

  return `${plural(node.subTopics, 'topic')} · ${plural(node.subMessages, 'message')}`;
}

// Grouped thousands: a public broker reaches six figures, which is unreadable without them.
const plural = (count: number, word: string) =>
  `${count.toLocaleString('en-US')} ${word}${count === 1 ? '' : 's'}`;

// Rebuilds only the message's path, keeping other branches' identity. Iterative, not
// recursive — deep topics used to overflow the call stack.
function insert(
  root: TopicNode,
  segments: string[],
  payload: string,
  at: number,
  qos: number,
  retain: boolean,
  mode: BodyMode,
): { node: TopicNode; isNewTopic: boolean } {
  const path = [root];
  for (const name of segments) {
    const parent = path[path.length - 1];
    path.push(parent.children.get(name) ?? leaf(name));
  }

  const target = path[path.length - 1];
  const isNewTopic = target.hits === 0;
  let node: TopicNode = {
    ...target,
    hits: target.hits + 1,
    latestPayload: payload,
    latestMode: mode,
    latestQos: qos,
    latestRetain: retain,
    lastHitAt: at,
    lastSubHitAt: at,
    subTopics: target.subTopics + (isNewTopic ? 1 : 0),
    subMessages: target.subMessages + 1,
  };

  for (let i = path.length - 2; i >= 0; i--) {
    const parent = path[i];
    node = {
      ...parent,
      ...linkChild(parent, segments[i], node),
      subTopics: parent.subTopics + (isNewTopic ? 1 : 0),
      subMessages: parent.subMessages + 1,
      lastSubHitAt: at,
    };
  }

  return { node, isNewTopic };
}

// Puts a child under its parent, and says where it sits.
//
// Identity lives on the nodes, not on these two structures: insert() gives every node along the
// message's path a fresh object, which is what memoised rows compare, and nothing ever diffs one
// parent's children against another's. So both are updated in place. The cost this avoids is
// real — rebuilding a map of n siblings per message was more work per second than a second has
// on a broker with thousands of top-level topics.
function linkChild(
  parent: TopicNode,
  name: string,
  child: TopicNode,
): { children: ReadonlyMap<string, TopicNode>; order: readonly string[] } {
  const children = parent.children as Map<string, TopicNode>;

  // The common case by far: another message on a topic already in the tree.
  if (children.has(name)) {
    children.set(name, child);
    return { children, order: parent.order };
  }

  children.set(name, child);

  // A brand new sibling has to land in alphabetical order. Binary search rather than a scan,
  // because localeCompare is the expensive part and this way it runs log(n) times, not n.
  const order = parent.order as string[];
  let low = 0;
  let high = order.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (order[mid].localeCompare(name, 'en') < 0) low = mid + 1;
    else high = mid;
  }
  order.splice(low, 0, name);

  return { children, order };
}
