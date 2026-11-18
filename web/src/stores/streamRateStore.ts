import { create } from 'zustand';

/** How much of the stream the rail's line holds: a minute, a reading a second. */
export const RATE_SECONDS = 60;

/** How often the count is turned into a reading. */
export const RATE_EVERY_MS = 1_000;

/**
 * How fast messages are arriving from the server, a reading a second for the last minute.
 *
 * Counted where they arrive rather than where they are taken in, so a console that has been
 * stopped still shows the broker sending: the line under a green Resume goes on moving, and says
 * the queue is filling rather than that the broker went quiet.
 *
 * Its own count rather than the health line's, because that one is read by being emptied, and a
 * second reader would take half of every second from it.
 */
type StreamRateState = {
  /** Arrivals since the last reading. Written without `set`; see `arrived`. */
  pending: number;
  /** Messages a second, oldest first, at most `RATE_SECONDS` of them. */
  readings: readonly number[];
  arrived: (messages: number) => void;
  /** Closes the second that is under way, and starts the next. */
  tick: () => void;
  /** A new tree is a new stream; the old broker's minute is not this one's. */
  reset: () => void;
};

export const useStreamRateStore = create<StreamRateState>((set, get) => ({
  pending: 0,
  readings: [],

  // Not through `set`: this is on the path every batch takes, and a subscriber woken by it would
  // be woken at the broker's rate rather than once a second.
  arrived: (messages) => {
    get().pending += messages;
  },

  tick: () => {
    const { pending, readings } = get();
    const next = [...readings, (pending * 1_000) / RATE_EVERY_MS];

    set({ pending: 0, readings: next.length > RATE_SECONDS ? next.slice(-RATE_SECONDS) : next });
  },

  reset: () => set({ pending: 0, readings: [] }),
}));
