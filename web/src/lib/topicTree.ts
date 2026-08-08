export type TopicNode = {
  name: string;
  children: ReadonlyMap<string, TopicNode>;
  latestPayload: string | null;
  hits: number;          // messages delivered directly to this topic
  subTopics: number;     // topics at or beneath it with a message
  lastHitAt: number;     // last message on this exact topic
  lastSubHitAt: number;  // last message at or beneath it; drives the flash
};

export const emptyTree = (): TopicNode => leaf('');

const leaf = (name: string): TopicNode => ({
  name,
  children: new Map(),
  latestPayload: null,
  hits: 0,
  subTopics: 0,
  lastHitAt: 0,
  lastSubHitAt: 0,
});

export function applyMessage(root: TopicNode, topic: string, payload: string, at: number): TopicNode {
  return insert(root, topic.split('/'), payload, at).node;
}

export function applyMessages(
  root: TopicNode,
  messages: ReadonlyArray<{ topic: string; payload: string }>,
  at: number,
): TopicNode {
  return messages.reduce((tree, message) => applyMessage(tree, message.topic, message.payload, at), root);
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
    const children = [...node.children.values()];
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
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

// Topic count for branches; nothing for leaves.
export function nodeSummary(node: TopicNode): string {
  return node.children.size > 0 ? plural(node.subTopics, 'topic') : '';
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

// Rebuilds only the message's path, keeping other branches' identity. Iterative, not
// recursive — deep topics used to overflow the call stack.
function insert(
  root: TopicNode,
  segments: string[],
  payload: string,
  at: number,
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
    lastHitAt: at,
    lastSubHitAt: at,
    subTopics: target.subTopics + (isNewTopic ? 1 : 0),
  };

  for (let i = path.length - 2; i >= 0; i--) {
    const parent = path[i];
    node = {
      ...parent,
      children: withChild(parent.children, segments[i], node),
      subTopics: parent.subTopics + (isNewTopic ? 1 : 0),
      lastSubHitAt: at,
    };
  }

  return { node, isNewTopic };
}

// Kept alphabetical so children don't reorder as messages arrive and rendering never sorts.
function withChild(
  children: ReadonlyMap<string, TopicNode>,
  name: string,
  child: TopicNode,
): ReadonlyMap<string, TopicNode> {
  const next = new Map<string, TopicNode>();

  if (children.has(name)) {
    for (const [key, value] of children) next.set(key, key === name ? child : value);
    return next;
  }

  let inserted = false;
  for (const [key, value] of children) {
    if (!inserted && key.localeCompare(name, 'en') > 0) {
      next.set(name, child);
      inserted = true;
    }
    next.set(key, value);
  }
  if (!inserted) next.set(name, child);

  return next;
}
