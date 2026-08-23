import { create } from 'zustand';

/**
 * What the console is carrying, and what carrying it costs.
 *
 * Counted rather than asked for: the two APIs that would answer this directly — `performance
 * .memory` and a long-task observer — are Chrome's alone, and the desktop build runs on the
 * system webview, where neither exists. Everything here is measured from the console's own work,
 * so the line reads the same wherever it is opened.
 */
type HealthState = {
  /** Arrivals taken in since the last reading. */
  arrived: number;
  /** What taking them cost, in milliseconds. */
  spentMs: number;
  took: (messages: number, ms: number) => void;
  /** Reads the run so far and starts a new one. */
  since: () => { arrived: number; spentMs: number };
  /**
   * Messages the server's queue had to drop, in total, because this console was behind.
   *
   * The one loss nothing here can count for itself: they never arrived. Cumulative rather than
   * per-reading, and so not cleared by `since` — a figure that went back to zero every second
   * would say a console had recovered when all it had done was stop falling further behind.
   */
  dropped: number;
  serverDropped: (total: number) => void;
};

export const useHealthStore = create<HealthState>((set, get) => ({
  arrived: 0,
  spentMs: 0,
  dropped: 0,

  // Not `set` with a function per arrival: this is on the path every message takes, and a
  // subscriber woken by it would be woken at the broker's rate rather than at the reader's.
  took: (messages, ms) => {
    const state = get();
    state.arrived += messages;
    state.spentMs += ms;
  },

  since: () => {
    const { arrived, spentMs } = get();
    set({ arrived: 0, spentMs: 0 });

    return { arrived, spentMs };
  },

  // Through `set`, unlike `took` above: this arrives when something has gone wrong rather than on
  // the path every message takes, so it can afford to wake whoever is watching.
  serverDropped: (total) => set({ dropped: total }),
}));
