import { create } from 'zustand';

/**
 * Whether the console is taking messages in at all.
 *
 * The other pause — the one in the log's foot — stops a pane from redrawing while the traffic
 * carries on behind it. This one stops the traffic: nothing reaches the log, the tree, or the
 * chart while it is on, and the console is exactly as the reader left it.
 *
 * What arrives while it is on is kept. It used to be counted and let go, on the reasoning that a
 * queue nobody is draining has no bound and that a resume after a long stop is an avalanche —
 * both true, and both now answered where they arise rather than by throwing the messages away:
 * the queue has a ceiling, and it is drained a frame at a time so the window keeps up. A reader
 * who stops the console is asking it to hold still, not to stop listening, and the traffic that
 * went past while they were reading is exactly the traffic they stopped it to read.
 *
 * The ceiling is the log's own capacity, so nothing is lost that the console could have shown
 * had it never stopped; past that the oldest go, which is what the log's ring would have done to
 * them anyway. `lost` says how many that was, because a console that quietly drops messages is
 * the thing this store exists to avoid.
 */
type PauseState = {
  paused: boolean;
  /** How many are queued, waiting to be taken in. Falls as they land. */
  waiting: number;
  /**
   * How many were let go of rather than taken in, since this stop began. Two causes, both rare:
   * a queue past the ceiling drops its oldest, and a queue held for a tree that has since
   * started again is dropped whole.
   */
  lost: number;
  toggle: () => void;
  /** Where the queue stands now. */
  track: (waiting: number) => void;
  /** How many were let go of rather than taken in. */
  lose: (messages: number) => void;
};

export const usePauseStore = create<PauseState>((set, get) => ({
  paused: false,
  waiting: 0,
  lost: 0,

  // Stopping starts a fresh account of what it cost; letting go leaves the queue to drain and
  // the numbers to fall with it.
  toggle: () => set(get().paused ? { paused: false } : { paused: true, lost: 0 }),

  // Not through `set`: these are on the path every message takes, and a subscriber woken by them
  // would be woken at the broker's rate. They are read when the line above them re-renders for
  // its own reasons, which is often enough for a number nobody is watching tick.
  track: (waiting) => {
    get().waiting = waiting;
  },

  lose: (messages) => {
    get().lost += messages;
  },
}));
