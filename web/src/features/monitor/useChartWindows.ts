import { create } from 'zustand';
import { openingBox, type Box } from './floating';

/**
 * The chart windows a reader has opened, each one standing over the console.
 *
 * The chart in the column answers for whatever is selected, and there is one of it. That is the
 * right answer for reading a topic and the wrong one for comparing two: a reader watching a kiln
 * and the room it is in has to click between them and hold the first in their head. A window is
 * that chart taken off the selection — it keeps the filter it was opened on and goes on drawing
 * it while the console below carries on being used for something else.
 *
 * Two of the same topic is allowed. It reads like a mistake and is not: one window on the last
 * ten minutes and another on the whole history, or the same run in two ranges side by side, are
 * both things this is for — and a rule against it would be the tool deciding what a reader is
 * comparing.
 */
export type ChartWindow = {
  id: string;
  /** What this window draws, and goes on drawing whatever the console selects next. */
  filter: string;
  label: string;
  box: Box;
  /**
   * Pinned in place. A window is opened pinned, because opening one is a deliberate act and a
   * chart that slid under the next drag would undo it; the pin comes out when the reader wants
   * to put it somewhere.
   */
  fixed: boolean;
};

type WindowState = {
  /** Back to front: the last one is the one on top, which is the one last opened or touched. */
  windows: ReadonlyArray<ChartWindow>;
  open: (filter: string, label: string) => void;
  close: (id: string) => void;
  place: (id: string, box: Box) => void;
  fix: (id: string, fixed: boolean) => void;
  raise: (id: string) => void;
};

let count = 0;

export const useChartWindows = create<WindowState>((set) => ({
  windows: [],

  // A new window opens where a new window opens: the middle of the screen, at the size the chart
  // has always thrown open at. Not stepped clear of the last one — that gave a reader opening
  // four of them a staircase — and not inherited from whatever it was opened from, which is how
  // the second one used to come out wherever the first had been dragged to. And last in the run,
  // so it is the one on top: a window that opened underneath the others would look like nothing
  // had happened at all.
  open: (filter, label) =>
    set((state) => {
      count += 1;

      return {
        windows: [
          ...state.windows,
          { id: `chart-${count}`, filter, label, box: openingBox(), fixed: true },
        ],
      };
    }),

  close: (id) => set((state) => ({ windows: state.windows.filter((one) => one.id !== id) })),

  place: (id, box) =>
    set((state) => ({
      windows: state.windows.map((one) => (one.id === id ? { ...one, box } : one)),
    })),

  fix: (id, fixed) =>
    set((state) => ({
      windows: state.windows.map((one) => (one.id === id ? { ...one, fixed } : one)),
    })),

  raise: (id) => set((state) => ({ windows: raised(state.windows, id) })),
}));

/** The named window to the end of the run, which is the top of the stack. */
function raised(windows: ReadonlyArray<ChartWindow>, id: string): ReadonlyArray<ChartWindow> {
  const chart = windows.find((one) => one.id === id);
  if (!chart || windows[windows.length - 1] === chart) return windows;

  return [...windows.filter((one) => one.id !== id), chart];
}
