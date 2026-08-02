import { create } from 'zustand';
import { applyMessages, emptyTree, type TopicNode } from '../lib/topicTree';
import type { MqttMessage } from '../types/api';

type TreeState = {
  root: TopicNode;
  // Only user-clicked paths appear here; others follow defaultOpen.
  openPaths: ReadonlyMap<string, boolean>;
  defaultOpen: boolean;
  apply: (messages: MqttMessage[]) => void;
  toggle: (path: string) => void;
  setAllOpen: (open: boolean) => void;
  reset: () => void;
};

export const useTopicTreeStore = create<TreeState>((set, get) => ({
  root: emptyTree(),
  openPaths: new Map(),
  defaultOpen: false,

  apply: (messages) => set((state) => ({ root: applyMessages(state.root, messages, Date.now()) })),

  toggle: (path) =>
    set((state) => {
      const openPaths = new Map(state.openPaths);
      openPaths.set(path, !isPathOpen(state, path));
      return { openPaths };
    }),

  // Also sets the default for branches that arrive later, so per-path choices are dropped.
  setAllOpen: (open) => set({ openPaths: new Map(), defaultOpen: open }),

  reset: () => set({ root: emptyTree(), openPaths: new Map(), defaultOpen: get().defaultOpen }),
}));

export const isPathOpen = (
  state: Pick<TreeState, 'openPaths' | 'defaultOpen'>,
  path: string,
): boolean => state.openPaths.get(path) ?? state.defaultOpen;
