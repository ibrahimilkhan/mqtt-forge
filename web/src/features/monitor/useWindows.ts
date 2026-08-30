import { create } from 'zustand';
import type { LogEntry } from '../../stores/logStore';
import { fullBox, moved, openingBox, type Box } from './floating';

/**
 * What a window is showing.
 *
 * Two kinds, one stack. A chart taken off the selection, and a message taken out of the run — and
 * they are the same object as far as being a window goes: both stand over the console, both are
 * moved by their bar and sized by their corner, both are pinned when they open, and only one of
 * them can be in front. That last one is why there is a single store rather than two: the array
 * IS the z-order, and two arrays each numbering their own would put two windows on the same
 * layer and leave which one wins to the order they happened to be drawn in.
 */
export type Pane =
  /** Goes on drawing this filter whatever the console selects next. */
  | { kind: 'chart'; filter: string }
  /** One arrival, frozen. The log behind it may evict it; the window keeps its copy. */
  | { kind: 'message'; entry: LogEntry };

/**
 * A window a reader has opened, standing over the console.
 *
 * The chart in the column answers for whatever is selected, and there is one of it. That is the
 * right answer for reading a topic and the wrong one for comparing two: a reader watching a kiln
 * and the room it is in has to click between them and hold the first in their head. A window is
 * that chart taken off the selection — it keeps the filter it was opened on and goes on drawing
 * it while the console below carries on being used for something else.
 *
 * Two charts of the same topic is allowed. It reads like a mistake and is not: one window on the
 * last ten minutes and another on the whole history, or the same run in two ranges side by side,
 * are both things this is for — and a rule against it would be the tool deciding what a reader
 * is comparing. Two windows on one message is a different matter, and see `open`.
 */
export type FloatWindow = {
  id: string;
  pane: Pane;
  label: string;
  box: Box;
  /**
   * Pinned in place. A window is opened pinned, because opening one is a deliberate act and a
   * chart that slid under the next drag would undo it; the pin comes out when the reader wants
   * to put it somewhere.
   */
  fixed: boolean;
  /**
   * Filling the viewport, with the box it came from kept for the way back.
   *
   * Three fifths of the screen is the right size for reading a run beside the console it came
   * from and the wrong one for a forty-thousand-character document — which is what a window
   * opened onto one message often holds. Kept here rather than worked out from the box, because
   * a window a reader had already dragged to fill the screen themselves would otherwise come back
   * from this to nowhere.
   */
  full: boolean;
  wasAt: Box | null;
};

type WindowState = {
  /** Back to front: the last one is the one on top, which is the one last opened or touched. */
  windows: ReadonlyArray<FloatWindow>;
  open: (pane: Pane, label: string, from?: Box) => void;
  close: (id: string) => void;
  swell: (id: string, full: boolean) => void;
  place: (id: string, box: Box) => void;
  fix: (id: string, fixed: boolean) => void;
  raise: (id: string) => void;
};

let count = 0;

/** Whether a window is already showing this exact arrival. */
const showing = (window: FloatWindow, pane: Pane) =>
  pane.kind === 'message' && window.pane.kind === 'message' && window.pane.entry.id === pane.entry.id;

export const useWindows = create<WindowState>((set) => ({
  windows: [],

  // A new window opens where a new window opens: the middle of the screen, at the size the chart
  // has always thrown open at. Not stepped clear of the last one — that gave a reader opening
  // four of them a staircase.
  //
  // `from` is where the chart it was opened from is standing, which is the middle too unless the
  // reader has moved it since. Taking it is what keeps the pin from moving anything: press it
  // and the window is where the chart was, whether that is the standard place or somewhere the
  // reader chose a moment ago.
  //
  // And last in the run, so it is the one on top: a window that opened underneath the others
  // would look like nothing had happened at all.
  open: (pane, label, from) =>
    set((state) => {
      // A message is one frozen arrival, so a second window on it would be the same thing twice
      // with nothing to tell them apart — the reader has pressed the same row again, and what
      // they mean by that is 'where did it go'. Bring it forward instead. Two charts of one
      // topic stay allowed, for the reason on Pane above: those two can differ.
      const already = state.windows.find((one) => showing(one, pane));
      if (already) return { windows: raised(state.windows, already.id) };

      count += 1;

      return {
        windows: [
          ...state.windows,
          {
            id: `window-${count}`,
            pane,
            label,
            box: from ? moved(from, 0, 0) : openingBox(),
            fixed: true,
            full: false,
            wasAt: null,
          },
        ],
      };
    }),

  close: (id) => set((state) => ({ windows: state.windows.filter((one) => one.id !== id) })),

  // Out to the whole viewport and back to exactly where it stood. `wasAt` is dropped on the way
  // back rather than kept: a window that has been put back has no way back to remember.
  swell: (id, full) =>
    set((state) => ({
      windows: state.windows.map((one) =>
        one.id !== id
          ? one
          : full
            ? { ...one, full: true, wasAt: one.box, box: fullBox() }
            : { ...one, full: false, wasAt: null, box: one.wasAt ?? one.box },
      ),
    })),

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
function raised(windows: ReadonlyArray<FloatWindow>, id: string): ReadonlyArray<FloatWindow> {
  const found = windows.find((one) => one.id === id);
  if (!found || windows[windows.length - 1] === found) return windows;

  return [...windows.filter((one) => one.id !== id), found];
}
