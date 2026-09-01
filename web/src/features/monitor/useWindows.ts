import { create } from 'zustand';
import type { LogEntry } from '../../stores/logStore';
import { fullBox, moved, openingBox, type Box } from './floating';

/**
 * What a window is showing.
 *
 * Three kinds, one stack. A chart taken off the selection, a message taken out of the run, and an
 * alert rule being written — and they are the same object as far as being a window goes: all three
 * stand over the console, all three are moved by their bar and sized by their corner, all three
 * are pinned when they open, and only one of them can be in front. That last one is why there is a
 * single store rather than three: the array IS the z-order, and three arrays each numbering their
 * own would put two windows on the same layer and leave which one wins to the order they happened
 * to be drawn in.
 */
export type Pane =
  /** Goes on drawing this filter whatever the console selects next. */
  | { kind: 'chart'; filter: string }
  /** One arrival, frozen. The log behind it may evict it; the window keeps its copy. */
  | { kind: 'message'; entry: LogEntry }
  /**
   * One alert rule being written.
   *
   * The DRAFT's id and not the rule's: a rule this console has invented has no server id yet, and
   * two new drafts have to be distinguishable. The draft itself lives in
   * `features/alerts/ruleDraft.ts` and outlives this window, so closing one loses no typing.
   */
  | { kind: 'rule'; draftId: string };

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
/**
 * The width below which a rule editor opens filling the screen.
 *
 * The same number the rail lies over the workspace at. A window's floor is 300 pixels wide, which
 * is narrower than the 320-pixel panel column the rule editor exists to escape — so on a phone a
 * three-fifths window would be the very form this feature refused to draw, only harder to reach.
 */
const NARROW = 760;

/** Whether a window is already showing this exact thing. */
// Two charts of one topic stay allowed, for the reason on `Pane`: those two can differ, one on the
// last ten minutes and one on the whole run. A message and a draft cannot. A second window on one
// arrival would be the same frozen thing twice with nothing to tell them apart, and a second window
// on one draft would be two forms writing over each other through one map — in both cases the
// reader has pressed the same thing again, and what they mean by that is 'where did it go'.
const showing = (window: FloatWindow, pane: Pane) =>
  (pane.kind === 'message' &&
    window.pane.kind === 'message' &&
    window.pane.entry.id === pane.entry.id) ||
  (pane.kind === 'rule' && window.pane.kind === 'rule' && window.pane.draftId === pane.draftId);
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
      // The reader has pressed the same row, or the same rule, again. Bring it forward.
      const already = state.windows.find((one) => showing(one, pane));
      if (already) return { windows: raised(state.windows, already.id) };

      count += 1;

      // A rule editor on a narrow screen takes the whole viewport. Ten condition types with their
      // own fields do not fit a column, which is why this is a window at all; three fifths of a
      // phone is that column again, with the console showing round the edges of it.
      const full = pane.kind === 'rule' && window.innerWidth <= NARROW;

      return {
        windows: [
          ...state.windows,
          {
            id: `window-${count}`,
            pane,
            label,
            box: full ? fullBox() : from ? moved(from, 0, 0) : openingBox(),
            fixed: true,
            full,
            // Where 'put it back' goes. A window that opened full has never stood anywhere, and
            // without this the swell would put it back to the size it already is — which is a
            // control that visibly does nothing.
            wasAt: full ? openingBox() : null,
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
