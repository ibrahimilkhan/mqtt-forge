import { create } from 'zustand';
import { moved, type Box } from './floating';

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
  pin: (filter: string, label: string, box: Box) => void;
  unpin: (id: string) => void;
  place: (id: string, box: Box) => void;
  raise: (id: string) => void;
};

let count = 0;

export const usePinnedStore = create<PinnedState>((set) => ({
  pinned: [],

  pin: (filter, label, box) =>
    set((state) => {
      // A topic already pinned is not pinned twice: the second window would draw the same run as
      // the first, over the top of it, and look like the first having gone wrong.
      const standing = state.pinned.find((chart) => chart.filter === filter);
      if (standing) return { pinned: raised(state.pinned, standing.id) };

      count += 1;

      // Where the window being pinned is standing, and nowhere else. It used to step clear of
      // anything already in that place, which sounds helpful and is not: the chart is thrown
      // open in the middle of the screen, so every pin after the first landed a little down and
      // to the right of the last, and a reader pinning four of them got a staircase nobody
      // asked for. Pinned where it was, the new window is exactly where the reader was already
      // looking — and it is the one on top, so nothing is hidden that they can see.
      return {
        pinned: [...state.pinned, { id: `pin-${count}`, filter, label, box: moved(box, 0, 0) }],
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
