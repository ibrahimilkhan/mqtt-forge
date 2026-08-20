import { create } from 'zustand';
import { openingBox, type Box } from './floating';

/**
 * The charts a reader has pinned to the console, each one a window of its own.
 *
 * The chart in the column answers for whatever is selected, and there is one of it. That is the
 * right answer for reading a topic and the wrong one for comparing two: a reader watching a
 * kiln and the room it is in has to click between them and hold the first in their head. A
 * pinned window is that chart taken off the selection — it keeps the filter it was pinned on and
 * goes on drawing it while the console below carries on being used for something else.
 */
export type PinnedChart = {
  id: string;
  /** What this window draws, and goes on drawing whatever the console selects next. */
  filter: string;
  label: string;
  box: Box;
};

type PinnedState = {
  /** Back to front: the last one is the one on top, which is the one last touched. */
  pinned: ReadonlyArray<PinnedChart>;
  pin: (filter: string, label: string) => void;
  unpin: (id: string) => void;
  place: (id: string, box: Box) => void;
  raise: (id: string) => void;
};

let count = 0;

export const usePinnedStore = create<PinnedState>((set) => ({
  pinned: [],

  pin: (filter, label) =>
    set((state) => {
      // A topic already pinned is not pinned twice: the second window would draw the same run as
      // the first, over the top of it, and look like the first having gone wrong.
      const standing = state.pinned.find((chart) => chart.filter === filter);
      if (standing) return { pinned: raised(state.pinned, standing.id) };

      count += 1;

      // A new window opens where a new window opens: the middle of the screen, at the size the
      // chart has always thrown open at. Not stepped clear of the last one — that gave a reader
      // pinning four of them a staircase — and not inherited from the window it was pinned
      // from, which is how the second one came out wherever the first had been dragged and
      // sized to. Every one of these is the first one, as far as where it starts is concerned.
      return {
        pinned: [...state.pinned, { id: `pin-${count}`, filter, label, box: openingBox() }],
      };
    }),

  unpin: (id) => set((state) => ({ pinned: state.pinned.filter((chart) => chart.id !== id) })),

  place: (id, box) =>
    set((state) => ({
      pinned: state.pinned.map((chart) => (chart.id === id ? { ...chart, box } : chart)),
    })),

  raise: (id) => set((state) => ({ pinned: raised(state.pinned, id) })),
}));

/** The named window to the end of the run, which is the top of the stack. */
function raised(pinned: ReadonlyArray<PinnedChart>, id: string): ReadonlyArray<PinnedChart> {
  const chart = pinned.find((one) => one.id === id);
  if (!chart || pinned[pinned.length - 1] === chart) return pinned;

  return [...pinned.filter((one) => one.id !== id), chart];
}
