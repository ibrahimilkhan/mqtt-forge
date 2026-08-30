import { create } from 'zustand';
import { matchesFilter } from '../lib/topicMatch';
import { applyMessages, emptyTree, nodeAt, pruneTopics, type TopicNode } from '../lib/topicTree';
import type { DecodedMessage } from '../realtime/decodeIncoming';

type TreeState = {
  root: TopicNode;
  // Only user-clicked paths appear here; others follow defaultOpen.
  openPaths: ReadonlyMap<string, boolean>;
  defaultOpen: boolean;
  // The broker row that everything hangs off. Its own field rather than a path in openPaths:
  // it defaults the other way (open), and collapse-all must not make the whole tree vanish.
  brokerOpen: boolean;
  apply: (messages: DecodedMessage[]) => void;
  dropFilter: (filter: string, stillSubscribed: readonly string[]) => void;
  toggle: (path: string) => void;
  toggleBroker: () => void;
  setAllOpen: (open: boolean, under?: string | null) => void;
  reset: () => void;
  /**
   * Goes up every time the tree starts again, which is every time a connection is made.
   *
   * Read by anything holding messages that were meant for the tree that has just gone: they
   * belong to a broker, or to a session, that is no longer the one on screen.
   */
  generation: number;
};

export const useTopicTreeStore = create<TreeState>((set, get) => ({
  root: emptyTree(),
  openPaths: new Map(),
  defaultOpen: false,
  brokerOpen: true,
  generation: 0,

  apply: (messages) => set((state) => ({ root: applyMessages(state.root, messages, Date.now()) })),

  // Messages stop arriving for a filter that was dropped, so what the tree still shows for it is
  // history the user just said they were done with. Overlapping subscriptions are the reason for
  // the second argument: with '#' still up, dropping 'sensors/#' changes nothing about what the
  // broker keeps sending, and the tree has to say so.
  dropFilter: (filter, stillSubscribed) =>
    set((state) => {
      const root = pruneTopics(
        state.root,
        (topic) =>
          matchesFilter(filter, topic) && !stillSubscribed.some((kept) => matchesFilter(kept, topic)),
      );

      return root === state.root ? state : { root };
    }),

  toggle: (path) =>
    set((state) => {
      const openPaths = new Map(state.openPaths);
      openPaths.set(path, !isPathOpen(state, path));
      return { openPaths };
    }),

  toggleBroker: () => set((state) => ({ brokerOpen: !state.brokerOpen })),

  /**
   * Open or shut every branch — of the whole tree, or of one branch of it.
   *
   * Whole-tree also sets the default for branches that arrive later, so per-path choices are
   * dropped. It reaches the broker row in both directions: everything hangs off that row, so
   * leaving it out made expanding open every branch behind a closed door and left collapsing with
   * the top level still standing. Folding it does not empty the pane — the row itself is drawn
   * whatever its state, so what is left is the tree closed down to its root.
   *
   * Given a branch, it touches that branch and what is under it and nothing else. A reader with
   * one subtree selected who presses expand means that subtree: on a broker carrying thousands of
   * topics, the whole-tree answer buries the thing they were looking at in everything they were
   * not. The default is left alone, so a branch that arrives later still behaves the way the last
   * whole-tree press said it should — a scoped press is about what is on screen, not a new rule.
   *
   * Opening a branch opens the way down to it as well. Otherwise the branch opens behind a shut
   * door, which is the same fault the broker row had.
   */
  setAllOpen: (open, under) =>
    set((state) => {
      if (!under) return { openPaths: new Map(), defaultOpen: open, brokerOpen: open };

      const node = nodeAt(state.root, under);
      if (!node) return {};

      const openPaths = new Map(state.openPaths);
      eachBranch(node, under, (path) => openPaths.set(path, open));

      if (open) {
        for (let cut = under.indexOf('/'); cut !== -1; cut = under.indexOf('/', cut + 1)) {
          openPaths.set(under.slice(0, cut), true);
        }
      }

      return { openPaths, brokerOpen: open ? true : state.brokerOpen };
    }),

  reset: () =>
    set({
      root: emptyTree(),
      openPaths: new Map(),
      defaultOpen: get().defaultOpen,
      brokerOpen: true,
      generation: get().generation + 1,
    }),
}));

/** A node and everything below it, by path. Depth is a topic's depth, so this cannot run away. */
function eachBranch(node: TopicNode, path: string, take: (path: string) => void) {
  take(path);

  for (const name of node.order) {
    const child = node.children.get(name);
    if (child) eachBranch(child, path === '' ? name : `${path}/${name}`, take);
  }
}

export const isPathOpen = (
  state: Pick<TreeState, 'openPaths' | 'defaultOpen'>,
  path: string,
): boolean => state.openPaths.get(path) ?? state.defaultOpen;
