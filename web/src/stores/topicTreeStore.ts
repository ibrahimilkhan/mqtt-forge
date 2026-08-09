import { create } from 'zustand';
import { matchesFilter } from '../lib/topicMatch';
import { applyMessages, emptyTree, pruneTopics, type TopicNode } from '../lib/topicTree';
import type { MqttMessage } from '../types/api';

type TreeState = {
  root: TopicNode;
  // Only user-clicked paths appear here; others follow defaultOpen.
  openPaths: ReadonlyMap<string, boolean>;
  defaultOpen: boolean;
  // The broker row that everything hangs off. Its own field rather than a path in openPaths:
  // it defaults the other way (open), and collapse-all must not make the whole tree vanish.
  brokerOpen: boolean;
  apply: (messages: MqttMessage[]) => void;
  dropFilter: (filter: string, stillSubscribed: readonly string[]) => void;
  toggle: (path: string) => void;
  toggleBroker: () => void;
  setAllOpen: (open: boolean) => void;
  reset: () => void;
};

export const useTopicTreeStore = create<TreeState>((set, get) => ({
  root: emptyTree(),
  openPaths: new Map(),
  defaultOpen: false,
  brokerOpen: true,

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

  // Also sets the default for branches that arrive later, so per-path choices are dropped.
  // Leaves the broker row alone: collapsing every branch should not empty the pane.
  setAllOpen: (open) => set({ openPaths: new Map(), defaultOpen: open }),

  reset: () =>
    set({ root: emptyTree(), openPaths: new Map(), defaultOpen: get().defaultOpen, brokerOpen: true }),
}));

export const isPathOpen = (
  state: Pick<TreeState, 'openPaths' | 'defaultOpen'>,
  path: string,
): boolean => state.openPaths.get(path) ?? state.defaultOpen;
