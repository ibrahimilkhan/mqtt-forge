import { asReading } from './number';
import type { BodyMode } from './payload';
import { found, type Where } from './sift';
import { matchesFilter } from './topicMatch';

export type TopicNode = {
  name: string;
  /** Lookup index, keyed by segment. Its own iteration order means nothing — `order` has that. */
  children: ReadonlyMap<string, TopicNode>;
  /** Child names, alphabetical. Held apart from the map so a new sibling is a splice into an
   *  array of strings rather than a rebuild of a map of thousands. */
  order: readonly string[];
  latestPayload: string | null;
  /**
   * Whether `latestPayload` is only the front of the message.
   *
   * The tree keeps a node per topic and the newest body on each, and a body is the one part of a
   * node with no natural size: fifty thousand topics carrying four-kilobyte documents is two
   * hundred megabytes of text held for a row that shows one line of it. So the body is cut at
   * MAX_TREE_PAYLOAD and this says when that happened.
   *
   * What it costs is exactness, in two places, and both are answered rather than accepted: the
   * publish form takes the whole body from the log's own run (see TopicTree's pickTopic), and the
   * alert editor's field discovery simply passes over a document it cannot parse, which it
   * already did for every body that is not JSON.
   */
  latestTruncated: boolean;
  latestMode: BodyMode | null;  // how latestPayload is written; null means no message of its own,
                                 // so a click must leave the publish form's mode untouched
  latestQos: number;     // settings of the last message on this exact topic, for re-publishing it
  latestRetain: boolean;
  hits: number;          // messages delivered directly to this topic
  subTopics: number;     // topics at or beneath it with a message
  subMessages: number;   // messages delivered at or beneath it
  lastHitAt: number;     // last message on this exact topic
  lastSubHitAt: number;  // last message at or beneath it; drives the flash
  /** The last few numbers this exact topic sent, oldest first, for the row's own sparkline. */
  readings: readonly number[];
};

/**
 * How long a run each row keeps.
 *
 * A tree row is a thumbnail, not a chart — the pane below it holds the history. Twenty-four is
 * about as much as forty pixels of line can say, and a broker with ten thousand topics keeping
 * that many numbers each is still a rounding error beside the log itself.
 */
export const TREE_READINGS = 24;

export const emptyTree = (): TopicNode => leaf('');

/**
 * What a node that has never had a child, or never carried a number, points at.
 *
 * Shared by every one of them rather than allocated each time. On a broker whose topics are
 * deep the tree is mostly chain: measured on Helsinki's feed, eleven nodes per topic, ninety-one
 * per cent of them holding exactly one child and every one of them holding no readings at all —
 * so this is tens of thousands of empty maps and arrays, each one saying the same nothing.
 *
 * Frozen, and copied before it is written to: `linkChild` gives a node its own map and order the
 * first time it gains a child, and a run of readings is always built as a new array. Nothing
 * mutates what is shared, and the freeze is there so that a future writer finds out at once.
 */
/**
 * The children of a node that has exactly one, which is what most nodes are.
 *
 * A tree of a broker whose topics are deep is mostly chain — measured on Helsinki's feed, ninety
 * one per cent of nodes hold a single child — and a Map costs 216 bytes to say so where this
 * costs 72. It answers to the same interface, so nothing that reads a node's children knows the
 * difference.
 *
 * `child` is written through rather than replaced, exactly as the Map it stands in for was: a
 * message on a topic already in the tree must not allocate, and every node along its path is
 * rebuilt on every message.
 */
class OnlyChild implements ReadonlyMap<string, TopicNode> {
  readonly key: string;
  child: TopicNode;

  constructor(key: string, child: TopicNode) {
    this.key = key;
    this.child = child;
  }

  get size(): number {
    return 1;
  }

  get(name: string): TopicNode | undefined {
    return name === this.key ? this.child : undefined;
  }

  has(name: string): boolean {
    return name === this.key;
  }

  forEach(run: (child: TopicNode, name: string, map: ReadonlyMap<string, TopicNode>) => void): void {
    run(this.child, this.key, this);
  }

  *entries(): MapIterator<[string, TopicNode]> {
    yield [this.key, this.child];
  }

  *keys(): MapIterator<string> {
    yield this.key;
  }

  *values(): MapIterator<TopicNode> {
    yield this.child;
  }

  [Symbol.iterator](): MapIterator<[string, TopicNode]> {
    return this.entries();
  }

  get [Symbol.toStringTag](): string {
    return 'Map';
  }
}

const NO_CHILDREN: ReadonlyMap<string, TopicNode> = Object.freeze(new Map<string, TopicNode>());
const NO_ORDER: readonly string[] = Object.freeze([]);
const NO_READINGS: readonly number[] = Object.freeze([]);

const leaf = (name: string): TopicNode => ({
  name,
  children: NO_CHILDREN,
  order: NO_ORDER,
  latestPayload: null,
  latestTruncated: false,
  latestMode: null,
  latestQos: 0,
  latestRetain: false,
  hits: 0,
  subTopics: 0,
  subMessages: 0,
  lastHitAt: 0,
  lastSubHitAt: 0,
  readings: NO_READINGS,
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
    /** The root is not a topic. Carried rather than inferred from an empty path, which a topic
     *  beginning with '/' also has. */
    isRoot: boolean;
  };

  const frame = (node: TopicNode, path: string, isRoot = false): Frame => ({
    node,
    path,
    index: 0,
    kept: new Map(),
    order: [],
    isRoot,
  });

  const stack: Frame[] = [frame(root, '', true)];
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
      stack.push(frame(child, current.isRoot ? name : `${current.path}/${name}`));
      continue;
    }

    stack.pop();
    finished = rebuild(current.node, current.path, current.isRoot, current.kept, current.order, remove);
  }

  // The root is never a topic, so it survives whatever happens beneath it.
  return finished ?? emptyTree();
}

function rebuild(
  node: TopicNode,
  path: string,
  isRoot: boolean,
  kept: Map<string, TopicNode>,
  order: string[],
  remove: (topic: string) => boolean,
): TopicNode | null {
  const dropped = !isRoot && remove(path);
  const survived =
    !dropped &&
    order.length === node.order.length &&
    order.every((name) => kept.get(name) === node.children.get(name));

  if (survived) return node;

  // Nothing of its own left and nothing underneath: the branch itself is gone. Not the root,
  // which has to hand back a tree even when it is empty.
  if (!isRoot && order.length === 0 && (dropped || node.hits === 0)) return null;

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
    latestTruncated: dropped ? false : node.latestTruncated,
    latestMode: dropped ? null : node.latestMode,
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

/**
 * The topics the tree is allowed to remember, as against to draw.
 *
 * The drawing cap above is about a screen; this one is about memory, and until it existed the
 * tree was the only structure in the console without a ceiling. Every distinct topic ever seen
 * made a node that lived until the next connection — which is fine for a broker whose topics are
 * a fixed set, and unbounded for one whose topic names carry an id: `request/<uuid>/response` is
 * a new node per message, and a console left open for days holds every one of them.
 *
 * Fifty thousand is far above what anyone reads — the screen stops at 1500 rows — and covers the
 * big real brokers whole. It is a count rather than a byte budget because counting nodes is exact
 * and cheap where measuring them in a browser is guesswork; the same reason logStore counts
 * readings.
 */
export const MAX_TREE_TOPICS = 50_000;

/**
 * The most of a message body the tree keeps, in characters.
 *
 * Four kilobytes is more than a row can show and more than any hand-written JSON document needs,
 * so the two things the body is for — the value on the row and the fields an alert rule can be
 * written against — are untouched for everything but the outliers. The log keeps the whole body
 * (256 KB a topic), which is where re-publishing reads it from.
 */
export const MAX_TREE_PAYLOAD = 4096;

/** How much is taken when the ceiling bites: a tenth, so the walk is paid once per five thousand
 *  topics rather than on every arrival past the cap. */
const EVICTION_SHARE = 0.1;

/**
 * The topics that have been quiet longest, for a tree that has to give some up.
 *
 * Quietest rather than oldest: in a monitor the topic least missed is the one that has said
 * nothing for the longest, which is the rule logStore's own eviction already follows. `keep` is
 * what the reader is looking at — a selection they would find empty is worse than a node kept.
 */
export function quietestTopics(root: TopicNode, count: number, keep?: string): string[] {
  if (count <= 0) return [];

  const found: { topic: string; at: number }[] = [];
  const stack: { node: TopicNode; path: string; isRoot: boolean }[] = [
    { node: root, path: '', isRoot: true },
  ];

  while (stack.length > 0) {
    const { node, path, isRoot } = stack.pop()!;

    // A node with hits is a topic in its own right; one without is only a folder on the way.
    if (!isRoot && node.hits > 0 && path !== keep) found.push({ topic: path, at: node.lastHitAt });

    for (const name of node.order) {
      stack.push({
        node: node.children.get(name)!,
        path: isRoot ? name : `${path}/${name}`,
        isRoot: false,
      });
    }
  }

  found.sort((a, b) => a.at - b.at);

  return found.slice(0, count).map((one) => one.topic);
}

/**
 * The tree with its quietest topics given up, or the very same tree when it is inside its ceiling.
 *
 * Returns the topics that went as well, because they have to leave the log with them: a row whose
 * click shows nothing, or a run of readings with no row to reach it from, is worse than either
 * being gone.
 */
export function evictQuietestTopics(
  root: TopicNode,
  ceiling: number = MAX_TREE_TOPICS,
  keep?: string,
): { root: TopicNode; forgotten: string[] } {
  if (root.subTopics <= ceiling) return { root, forgotten: [] };

  // Down to the ceiling, and a tenth further, so the next arrival does not walk the tree again.
  const over = root.subTopics - ceiling;
  const victims = new Set(
    quietestTopics(root, over + Math.floor(ceiling * EVICTION_SHARE), keep),
  );

  if (victims.size === 0) return { root, forgotten: [] };

  return { root: pruneTopics(root, (topic) => victims.has(topic)), forgotten: [...victims] };
}

// Flattens the visible part of the tree so rendering never walks a closed subtree.
// Iterative, matching insert() — deep topics would overflow a recursive walk.
export function flattenTree(
  root: TopicNode,
  isOpen: (path: string) => boolean,
  limit: number,
): { rows: TopicRow[]; hidden: number } {
  const rows: TopicRow[] = [];
  // Counted while the rows are built, so what is left over does not have to be walked for.
  let shown = 0;

  // Reverse order in, so popping walks siblings alphabetically.
  const stack: TopicRow[] = [];
  const descend = (node: TopicNode, path: string, depth: number) => {
    const { order, children } = node;
    for (let i = order.length - 1; i >= 0; i--) {
      const child = children.get(order[i])!;
      stack.push({
        node: child,
        // Depth, not the truthiness of `path`: a topic beginning with '/' has an empty first
        // segment, whose path is legitimately '' — and joining from it must still produce the
        // leading slash. Only the root, which is not a topic, contributes no prefix at all.
        path: depth === 0 ? child.name : `${path}/${child.name}`,
        depth,
        isBranch: child.children.size > 0,
        open: false,
      });
    }
  };

  descend(root, '', 0);

  while (stack.length > 0) {
    // Past the cap the walk stops rather than carrying on to count what it will not draw.
    // It was descending into every open node the broker had, building a path string and a row
    // object for each, and then throwing all but the first fifteen hundred away: measured on
    // Helsinki's feed, ten thousand topics cost twice what two thousand did for exactly the
    // same fifteen hundred rows on screen.
    if (rows.length >= limit) break;

    const row = stack.pop()!;
    row.open = row.isBranch && isOpen(row.path);

    rows.push(row);
    if (row.node.hits > 0) shown++;

    if (row.open) descend(row.node, row.path, row.depth + 1);
  }

  // Only once the cap has bitten is anything hidden, and then it is counted from the tree's own
  // running totals rather than by walking to the end of it. What it counts is topics rather than
  // rows — which is what the line under the tree has always said out loud — so a branch nobody
  // has opened is counted here too. Uncapped, as before, nothing is hidden.
  const hidden = rows.length < limit ? 0 : Math.max(root.subTopics - shown, 0);

  return { rows, hidden };
}

/**
 * The topics that answer a search, as a flat list of rows.
 *
 * Flat, deliberately. Under a search the shape of the tree is not the answer: a reader who types
 * `boiler` wants the topics with boiler in them, wherever they hang, and a filtered *tree* would
 * make them open three branches to reach each one — which is the work the box exists to save.
 * So every match is drawn at the top level, by its whole path, and the tree comes back the
 * moment the box is emptied.
 *
 * What a message search reads is the newest message on each topic, and only the front of it: the
 * tree keeps one payload per topic, cut at MAX_TREE_PAYLOAD, because it keeps one for every
 * topic there is. The log is where a whole run is searched, and it has its own box.
 *
 * Iterative for the reason every other walk here is: a deep broker would overflow a recursive
 * one. Capped for the reason the flatten above is: past the cap the walk stops rather than
 * building rows nothing will draw.
 */
export function searchRows(
  root: TopicNode,
  look: string,
  where: Where,
  limit: number,
): { rows: TopicRow[]; hidden: number } {
  const rows: TopicRow[] = [];
  let matched = 0;

  const stack: Array<{ node: TopicNode; path: string }> = [];
  const descend = (node: TopicNode, path: string) => {
    const { order, children } = node;
    for (let i = order.length - 1; i >= 0; i--) {
      const child = children.get(order[i])!;
      stack.push({ node: child, path: path === '' ? child.name : `${path}/${child.name}` });
    }
  };

  descend(root, '');

  while (stack.length > 0) {
    const { node, path } = stack.pop()!;

    if (found({ topic: path, body: node.latestPayload }, look, where)) {
      matched++;
      if (rows.length < limit) {
        rows.push({ node, path, depth: 0, isBranch: node.children.size > 0, open: false });
      }
    }

    descend(node, path);
  }

  return { rows, hidden: Math.max(matched - rows.length, 0) };
}

// What a branch is carrying; nothing for leaves, whose own payload is on the row already.
/**
 * Every node a filter covers, by path, exactly as it stands now.
 *
 * For holding a branch of the tree still. Every message gives each node on its path a fresh
 * object — that is what the memoised rows compare — so a node captured here goes on saying what
 * it said at the moment of capture however much arrives behind it. What is not captured is the
 * `children` map, which is updated in place; nothing here reads one, and a row reads only the
 * fields of its own node.
 *
 * A topic that arrives under the filter afterwards is absent, which is how the caller tells it
 * apart from one that was already there: it has no frozen self to draw.
 */
export function snapshotUnder(root: TopicNode, filter: string): Map<string, TopicNode> {
  const frozen = new Map<string, TopicNode>();
  const branch = filterPath(filter);

  // Every hold the tree can take is a row's own filter — a path with '/#' on the end — so the
  // walk starts at that row rather than at the root and matches nothing on the way. On a broker
  // with fifty thousand topics, holding one of them reads one node instead of all of them.
  if (branch !== null) {
    let node: TopicNode | undefined = root;
    for (const name of branch.split('/')) {
      node = node?.children.get(name);
      if (!node) return frozen;
    }

    return under(node, branch, frozen);
  }

  // Anything else — a '+' in the middle, a filter that came from somewhere other than a row —
  // is answered by asking the matcher about every topic there is.
  const stack: Array<{ node: TopicNode; path: string; isRoot: boolean }> = [
    { node: root, path: '', isRoot: true },
  ];

  while (stack.length > 0) {
    const { node, path, isRoot } = stack.pop()!;

    if (!isRoot && matchesFilter(filter, path)) frozen.set(path, node);

    for (const [name, child] of node.children) {
      stack.push({ node: child, path: isRoot ? name : `${path}/${name}`, isRoot: false });
    }
  }

  return frozen;
}

/**
 * The path a `path/#` filter hangs off, or null for anything that does not name one — a filter
 * with a `+` in it, or the `#` that means every topic there is.
 *
 * Every hold the tree can take is a row's own filter, so this answers with that row's path: what
 * the hold is over, which is also what has to be kept out of the counts above it.
 */
export function filterPath(filter: string): string | null {
  if (!filter.endsWith('/#') || filter.includes('+')) return null;

  const path = filter.slice(0, -2);

  return path.includes('#') ? null : path;
}

/** The node at a slash-separated path, or null where the tree has none. */
export function nodeAt(root: TopicNode, path: string): TopicNode | null {
  let node: TopicNode | undefined = root;
  for (const name of path.split('/')) {
    node = node?.children.get(name);
    if (!node) return null;
  }

  return node;
}

/** One subtree, path by path, into the map given. */
function under(
  root: TopicNode,
  path: string,
  frozen: Map<string, TopicNode>,
): Map<string, TopicNode> {
  const stack: Array<{ node: TopicNode; path: string }> = [{ node: root, path }];

  while (stack.length > 0) {
    const { node, path: at } = stack.pop()!;

    frozen.set(at, node);
    for (const [name, child] of node.children) stack.push({ node: child, path: `${at}/${name}` });
  }

  return frozen;
}

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

  // Binary is not a reading even where its hex parses: '10' as hex is the byte 0x10, and a row
  // drawing it as ten would be drawing a number that never crossed the wire.
  const reading = mode === 'hex' ? null : asReading(payload);
  const readings =
    reading === null
      ? target.readings
      : [...target.readings, reading].slice(-TREE_READINGS);

  let node: TopicNode = {
    ...target,
    readings,
    hits: target.hits + 1,
    latestPayload: payload.length > MAX_TREE_PAYLOAD ? payload.slice(0, MAX_TREE_PAYLOAD) : payload,
    latestTruncated: payload.length > MAX_TREE_PAYLOAD,
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
  const held = parent.children;

  // A node that has never had a child is sharing the empty map and order with every other such
  // node, so its first child is what gives it its own — and one child does not need a map.
  if (held === NO_CHILDREN) {
    return { children: new OnlyChild(name, child), order: [name] };
  }

  if (held instanceof OnlyChild) {
    // The common case on a deep broker: another message on the one topic under it. Written
    // through rather than replaced, so a message costs nothing along its path.
    if (held.key === name) {
      held.child = child;
      return { children: held, order: parent.order };
    }

    // A second child, and now a map earns what it costs.
    const grown = new Map<string, TopicNode>([[held.key, held.child]]);
    grown.set(name, child);

    return {
      children: grown,
      order: held.key.localeCompare(name, 'en') < 0 ? [held.key, name] : [name, held.key],
    };
  }

  const children = held as Map<string, TopicNode>;

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
