export type TopicNode = {
  name: string;
  children: ReadonlyMap<string, TopicNode>;
  latestPayload: string | null;
  hits: number;          // messages delivered directly to this topic
  subTopics: number;     // topics beneath it, itself included, that received a message
  subMessages: number;   // total messages beneath it, itself included
  lastHitAt: number;     // when a message last landed on this exact topic
  lastSubHitAt: number;  // when a message last landed anywhere beneath it; drives the flash
};

export const emptyTree = (): TopicNode => leaf('');

const leaf = (name: string): TopicNode => ({
  name,
  children: new Map(),
  latestPayload: null,
  hits: 0,
  subTopics: 0,
  subMessages: 0,
  lastHitAt: 0,
  lastSubHitAt: 0,
});

export function applyMessage(root: TopicNode, topic: string, payload: string, at: number): TopicNode {
  return insert(root, topic.split('/'), 0, payload, at).node;
}

export function applyMessages(
  root: TopicNode,
  messages: ReadonlyArray<{ topic: string; payload: string }>,
  at: number,
): TopicNode {
  return messages.reduce((tree, message) => applyMessage(tree, message.topic, message.payload, at), root);
}

// Branch headings show the subtree summary; leaves show their own counter.
export function nodeSummary(node: TopicNode): string {
  if (node.children.size > 0) {
    return `${plural(node.subTopics, 'topic')} · ${plural(node.subMessages, 'message')}`;
  }
  return node.hits > 1 ? `×${node.hits}` : '';
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

// Rebuilds only the nodes on the message's path; every other branch keeps its identity.
function insert(
  node: TopicNode,
  segments: string[],
  depth: number,
  payload: string,
  at: number,
): { node: TopicNode; isNewTopic: boolean } {
  if (depth === segments.length) {
    const isNewTopic = node.hits === 0;
    return {
      node: {
        ...node,
        hits: node.hits + 1,
        latestPayload: payload,
        lastHitAt: at,
        lastSubHitAt: at,
        subMessages: node.subMessages + 1,
        subTopics: node.subTopics + (isNewTopic ? 1 : 0),
      },
      isNewTopic,
    };
  }

  const name = segments[depth];
  const child = insert(node.children.get(name) ?? leaf(name), segments, depth + 1, payload, at);

  return {
    node: {
      ...node,
      children: withChild(node.children, name, child.node),
      subMessages: node.subMessages + 1,
      subTopics: node.subTopics + (child.isNewTopic ? 1 : 0),
      lastSubHitAt: at,
    },
    isNewTopic: child.isNewTopic,
  };
}

// Children are stored in alphabetical order so the tree does not jump around as messages
// arrive and the render path never has to sort.
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
