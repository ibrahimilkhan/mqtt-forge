import { runsFor, type LogEntry } from '../stores/logStore';
import type { TopicRing } from '../stores/topicRing';
import { showsTopic } from './topicMatch';
import { EMPTY_LEVEL, filterPath, nodeAt, type TopicNode } from './topicTree';

/**
 * A pause on a row of the tree: a branch of the console — or the whole of it — kept still at the
 * moment the reader pressed it.
 *
 * Every question about what one covers is answered here, and only here. They used to be answered
 * four times — by the tree, by the log and the chart, by the control, by Manage — and the four
 * answers disagreed: a reader paused `/`, picked the broker's row above it, and watched the log
 * stream on under counts that had stopped.
 *
 * What a hold keeps is what was on screen when it was taken, a topic at a time: the run the log
 * was showing and the row the tree was drawing, and for `#` the broker's own row. Each row's own
 * child list is still the live tree's — nodes are fresh objects per message but their children are
 * updated in place — so a frozen row is read for its own fields and never for its children.
 */
export type Held = {
  /** `#`, or the `path/#` of the row it was taken on. */
  filter: string;
  /** The row's path, or null for `#`. */
  path: string | null;
  /** Topic → the run as it was shown, newest first. Never written to. */
  runs: ReadonlyMap<string, LogEntry[]>;
  /** Path → the row as it was drawn, for every row in the region. */
  nodes: ReadonlyMap<string, TopicNode>;
  /** The broker's row as it was drawn, for `#`; null for a branch. */
  root: TopicNode | null;
};

export type Holds = ReadonlyMap<string, Held>;

/** What a region has kept back since it was frozen. */
export type Behind = { messages: number; topics: number };

/** The filter the broker's row selects, and the hold that stands over everything. */
export const EVERYTHING = '#';

const NOTHING_BEHIND: Behind = { messages: 0, topics: 0 };

/**
 * The path a hold on this filter stands on: null for `#`, the row's path for `path/#`, and
 * undefined for anything else — a filter no row selects, which nothing offers to hold.
 */
export function regionOf(filter: string): string | null | undefined {
  if (filter === EVERYTHING) return null;

  return filterPath(filter) ?? undefined;
}

export const canHold = (filter: string | undefined): filter is string =>
  filter !== undefined && regionOf(filter) !== undefined;

/** Whether a path — a topic, or a branch on the way to some — lies in a hold's region. */
export function inRegion(held: Held, path: string): boolean {
  return held.path === null || path === held.path || path.startsWith(`${held.path}/`);
}

/**
 * How deep a region stands.
 *
 * `#` is above every branch, the empty first level's included — the two used to sort as equals,
 * and which of them drew the rows under `/` depended on which the reader took first. A region
 * nested in another has a path that extends the outer one's, so the longer path is the deeper.
 */
const depthOf = (held: Held): number => (held.path === null ? -1 : held.path.length);

/** The deepest hold whose region holds this path, or null — the one that draws it. */
export function nearestHold(holds: Iterable<Held>, path: string): Held | null {
  let nearest: Held | null = null;

  for (const held of holds) {
    if (inRegion(held, path) && (nearest === null || depthOf(held) > depthOf(nearest))) {
      nearest = held;
    }
  }

  return nearest;
}

/**
 * The holds no other hold contains.
 *
 * The rows above a hold leave out what it keeps back, and a hold nested in another is already
 * inside what the outer one keeps back: subtracting both took the same messages off twice.
 */
export function outermost(holds: Iterable<Held>): Held[] {
  const all = [...holds];

  return all.filter(
    (held) =>
      !all.some((other) => other !== held && held.path !== null && inRegion(other, held.path)),
  );
}

/**
 * What arrived under a region after it was frozen: the live row at its top against the frozen one.
 *
 * Each figure is clamped at nothing. An unsubscribe or a Clear can take rows out from under a
 * hold, and a count that went up because rows went away would be a worse lie than a zero.
 */
export function behind(held: Held, root: TopicNode): Behind {
  const live = held.path === null ? root : nodeAt(root, held.path);
  const frozen = held.path === null ? held.root : (held.nodes.get(held.path) ?? null);
  if (!live || !frozen) return NOTHING_BEHIND;

  return {
    messages: Math.max(0, live.subMessages - frozen.subMessages),
    topics: Math.max(0, live.subTopics - frozen.subTopics),
  };
}

/**
 * A row with held-back traffic taken out of its totals — or the very same row when there is none,
 * so a memoised row above nothing held does not redraw.
 */
export function discount(node: TopicNode, by: Behind): TopicNode {
  if (by.messages === 0 && by.topics === 0) return node;

  return {
    ...node,
    subTopics: node.subTopics - by.topics,
    subMessages: node.subMessages - by.messages,
  };
}

/**
 * Whether a hold's region holds any topic this filter shows.
 *
 * Compared a level at a time: `+` answers any level and `#` the rest. A filter opening with a
 * wildcard reaches no `$` region unless it is `#` itself, which is the one filter that means
 * everything the console holds — see showsTopic.
 */
export function reaches(filter: string, held: Held): boolean {
  if (filter === EVERYTHING || held.path === null) return true;

  const parts = filter.split('/');
  const levels = held.path.split('/');
  if ((parts[0] === '+' || parts[0] === '#') && levels[0].startsWith('$')) return false;

  for (let i = 0; i < levels.length; i++) {
    if (i >= parts.length) return false;
    if (parts[i] === '#') return true;
    if (parts[i] !== '+' && parts[i] !== levels[i]) return false;
  }

  return true;
}

/**
 * Whether a hold's region holds every topic this filter shows: the filter's lead — its levels up
 * to the first wildcard — lies in the region. A filter opening with a wildcard fans out over every
 * first level, and lies in no branch.
 */
export function covers(held: Held, filter: string): boolean {
  if (held.path === null) return true;
  if (filter === EVERYTHING) return false;

  const lead: string[] = [];
  for (const part of filter.split('/')) {
    if (part === '+' || part === '#') break;
    lead.push(part);
  }

  return lead.length > 0 && inRegion(held, lead.join('/'));
}

/** How a filter stands against the holds. */
export type PaneState = {
  /** The hold taken on exactly this filter. */
  own: Held | null;
  /** The nearest hold holding everything the filter shows — the own hold, when there is one. */
  over: Held | null;
  /** Whether any hold holds some topic the filter shows. */
  touched: boolean;
};

export const LIVE: PaneState = { own: null, over: null, touched: false };

export function paneState(holds: Holds, filter: string | undefined): PaneState {
  if (!filter || holds.size === 0) return LIVE;

  let over: Held | null = null;
  let touched = false;

  for (const held of holds.values()) {
    if (reaches(filter, held)) touched = true;
    if (covers(held, filter) && (over === null || depthOf(held) > depthOf(over))) over = held;
  }

  return { own: holds.get(filter) ?? null, over, touched };
}

/**
 * What a hold is called where it is named to a reader: the broker for `#`, the slash for the empty
 * first level, and otherwise its path.
 */
export function holdName(held: Pick<Held, 'path'>, broker: string): string {
  if (held.path === null) return broker;

  return held.path === '' ? EMPTY_LEVEL : held.path;
}

/** How the tree is drawn under a set of holds. */
export type TreeView = {
  /** The broker's row. */
  root: TopicNode;
  /** A row as drawn, and whether a hold draws it; null while a hold keeps it off screen. */
  row: (path: string, live: TopicNode) => { node: TopicNode; held: boolean } | null;
};

/**
 * The tree as the holds draw it.
 *
 * A row under a hold is drawn from the nearest hold, and a row that hold has nothing for arrived
 * behind it and is not drawn: the rows stop where they are, and one appearing is not standing
 * still. A row under no hold is drawn from the live tree with what the outermost holds beneath it
 * keep back taken out of its totals, so a branch never counts more than its rows add up to. The
 * broker's row is a row like any other in that — frozen when `#` is held, discounted otherwise.
 */
export function treeView(holds: Holds, root: TopicNode): TreeView {
  if (holds.size === 0) return { root, row: (_path, live) => ({ node: live, held: false }) };

  const outer = outermost(holds.values()).flatMap((one) =>
    one.path === null ? [] : [{ path: one.path, by: behind(one, root) }],
  );

  const beneath = (path: string | null): Behind => {
    let messages = 0;
    let topics = 0;

    for (const one of outer) {
      if (path !== null && !one.path.startsWith(`${path}/`)) continue;
      messages += one.by.messages;
      topics += one.by.topics;
    }

    return { messages, topics };
  };

  return {
    root: holds.get(EVERYTHING)?.root ?? discount(root, beneath(null)),
    row: (path, live) => {
      const held = nearestHold(holds.values(), path);
      if (held) {
        const node = held.nodes.get(path);
        return node ? { node, held: true } : null;
      }

      return { node: discount(live, beneath(path)), held: false };
    },
  };
}

/**
 * The runs a filter shows, one per topic, newest first.
 *
 * With no hold near the filter this is the log's own answer and costs nothing more. Otherwise a
 * topic under a hold shows the hold's run — narrowed to the topic, so a row picked under a paused
 * branch shows its own readings rather than the branch's — and a topic under none shows the live
 * run. A topic that arrived behind a hold is not shown, and a topic the log has let go of is still
 * shown from the hold that froze it.
 */
export function shownRuns(
  byTopic: ReadonlyMap<string, TopicRing>,
  holds: Holds,
  filter: string,
): LogEntry[][] {
  if (!filter) return [];

  const touching = [...holds.values()].filter((one) => reaches(filter, one));
  if (touching.length === 0) return runsFor(byTopic, filter);

  const runs: LogEntry[][] = [];

  for (const [topic, ring] of byTopic) {
    if (!showsTopic(filter, topic)) continue;

    const held = nearestHold(touching, topic);
    const run = held ? held.runs.get(topic) : ring.newestFirst();
    if (run && run.length > 0) runs.push(run);
  }

  for (const held of touching) {
    for (const [topic, run] of held.runs) {
      if (byTopic.has(topic) || run.length === 0 || !showsTopic(filter, topic)) continue;
      if (nearestHold(touching, topic) === held) runs.push(run);
    }
  }

  return runs;
}

/**
 * How much has arrived behind the holds a filter shows through — for one hold, or all of them.
 *
 * Per topic, against the newest message its hold froze, so a hold taken from another hold's frozen
 * view counts everything since that view rather than since the moment it was itself taken.
 */
export function arrivedBehind(
  byTopic: ReadonlyMap<string, TopicRing>,
  holds: Holds,
  filter: string,
  only?: Held,
): number {
  const touching = [...holds.values()].filter((one) => reaches(filter, one));
  if (touching.length === 0) return 0;

  let count = 0;

  for (const [topic, ring] of byTopic) {
    if (!showsTopic(filter, topic)) continue;

    const held = nearestHold(touching, topic);
    if (!held || (only !== undefined && held !== only)) continue;

    const newest = held.runs.get(topic)?.[0]?.id ?? -1;
    if (ring.newestId > newest) count += ring.countNewerThan(newest);
  }

  return count;
}

/**
 * A hold on a row's filter, frozen from what the console is showing — never from the live stores.
 *
 * That difference is the whole of it. A hold read off the live log and tree, taken on a row under
 * a branch that was already paused, showed the reader everything that had arrived behind the branch
 * the moment they pressed it: the row and the pane jumped forward, under a control that said pause.
 */
export function freeze(
  filter: string,
  byTopic: ReadonlyMap<string, TopicRing>,
  root: TopicNode,
  holds: Holds,
): Held | null {
  const path = regionOf(filter);
  if (path === undefined) return null;

  const runs = new Map<string, LogEntry[]>();
  for (const run of shownRuns(byTopic, holds, filter)) runs.set(run[0].topic!, run.slice());

  const view = treeView(holds, root);
  const nodes = new Map<string, TopicNode>();
  const stack: Array<{ node: TopicNode; at: string }> = [];

  if (path === null) {
    for (const [name, child] of root.children) stack.push({ node: child, at: name });
  } else {
    const top = nodeAt(root, path);
    if (top) stack.push({ node: top, at: path });
  }

  while (stack.length > 0) {
    const { node, at } = stack.pop()!;
    const drawn = view.row(at, node);

    // Kept off screen by a hold already standing: it arrived behind that hold, and so did
    // everything under it.
    if (drawn === null) continue;

    nodes.set(at, drawn.node);
    for (const [name, child] of node.children) stack.push({ node: child, at: `${at}/${name}` });
  }

  return { filter, path, runs, nodes, root: path === null ? view.root : null };
}
