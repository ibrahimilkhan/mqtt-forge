import { create } from 'zustand';
import type { Where } from '../lib/sift';

/**
 * What the reader is looking for, and where.
 *
 * In a store rather than in the panes themselves because two things read each search: the pane
 * that filters its rows, and the strip above it that counts them — the log's count sits in the
 * workspace's own region head, which knows nothing about the log and should go on knowing
 * nothing about it.
 *
 * One search per pane, not one shared between them. The tree and the log answer different
 * questions — which topics are there, and what did this one say — and a reader narrowing the
 * tree to `boiler` has not asked for the log of the topic they then click to be narrowed too.
 */
export type Sought = { look: string; where: Where };

type SearchState = {
  log: Sought;
  tree: Sought;
  setLog: (sought: Partial<Sought>) => void;
  setTree: (sought: Partial<Sought>) => void;
  /** Both boxes emptied. What a fresh connection, or a cleared log, leaves behind it. */
  clear: () => void;
};

const NOTHING: Sought = { look: '', where: 'both' };

export const useSearchStore = create<SearchState>((set) => ({
  log: { ...NOTHING },
  tree: { ...NOTHING },

  setLog: (sought) => set((state) => ({ log: { ...state.log, ...sought } })),
  setTree: (sought) => set((state) => ({ tree: { ...state.tree, ...sought } })),
  clear: () => set({ log: { ...NOTHING }, tree: { ...NOTHING } }),
}));
