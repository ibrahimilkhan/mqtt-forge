import type { LogEntry } from '../stores/logStore';
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
