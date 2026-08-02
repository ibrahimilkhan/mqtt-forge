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
  return insert(root, topic.split('/'), payload, at).node;
}

export function applyMessages(
  root: TopicNode,
  messages: ReadonlyArray<{ topic: string; payload: string }>,
  at: number,
): TopicNode {
  return messages.reduce((tree, message) => applyMessage(tree, message.topic, message.payload, at), root);
}

// Branch headings show the topic count; leaves show nothing.
export function nodeSummary(node: TopicNode): string {
  return node.children.size > 0 ? plural(node.subTopics, 'topic') : '';
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

// Rebuilds only the nodes on the message's path; every other branch keeps its identity.
// Iterative on purpose: a topic is free to have thousands of '/' segments, and a
// recursive walk that deep used to overflow the call stack.
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
    subMessages: target.subMessages + 1,
    subTopics: target.subTopics + (isNewTopic ? 1 : 0),
  };

  for (let i = path.length - 2; i >= 0; i--) {
    const parent = path[i];
    node = {
      ...parent,
      children: withChild(parent.children, segments[i], node),
      subMessages: parent.subMessages + 1,
      subTopics: parent.subTopics + (isNewTopic ? 1 : 0),
      lastSubHitAt: at,
    };
  }

  return { node, isNewTopic };
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
