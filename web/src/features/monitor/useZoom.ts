import { useEffect } from 'react';
import { create } from 'zustand';
import { fullBox, openingBox, type Box } from './floating';

/**
 * Whether the chart has been lifted out of its column.
 *
 * The chart lives in a third of a column that is itself a third of the window, which is the right
 * size for glancing at a run and the wrong size for reading one. Folding the two regions around
 * it helps and is two clicks; this is one, and it reaches past the column entirely.
 *
 * Open, it takes three fifths of the window and leaves the console readable around it — and
 * live, since nothing it draws blocks a pointer. A reader with the chart open can still click a
 * topic in the tree and watch this redraw for it, which is the thing they were going to do next.
 *
 * A store rather than state in the chart: the pane that has to become an overlay is the region
 * around it, and that is placed by the workspace, three components up.
 */
type ZoomState = {
  zoomed: boolean;
  /** Where it stands, once it has been opened at least once. Null until then. */
  box: Box | null;
  /** Filling the screen, which is a state rather than a size: it follows the window. */
  full: boolean;
  /** Where it stood before it filled the screen, so putting it back has somewhere to go. */
  wasAt: Box | null;
  toggle: () => void;
  close: () => void;
  place: (box: Box) => void;
  swell: (full: boolean) => void;
};

export const useZoomStore = create<ZoomState>((set) => ({
  zoomed: false,
  box: null,
  full: false,
  wasAt: null,

  // Always the standard place: the middle of the screen, at three fifths of it.
  //
  // It used to be remembered across closings, which sounds like a courtesy and was the cause of
  // the one real surprise in this whole arrangement. A chart dragged aside and closed came back
  // aside; the window its pin then opened came up in the middle, where windows open — so
  // pressing the pin moved the chart across the screen, and it was the remembering that moved
  // it, not the pin. Opened in the same place every time, the pin has nothing to move.
  toggle: () =>
    set((state) =>
      state.zoomed
        ? { zoomed: false, full: false, wasAt: null }
        : { zoomed: true, box: openingBox(), full: false, wasAt: null },
    ),

  close: () => set({ zoomed: false, full: false, wasAt: null }),
  place: (box) => set({ box }),

  /**
   * Out to the whole screen and back, the same gesture a pinned window has.
   *
   * Where it stood is kept rather than recomputed, because 'back' means back where the reader
   * put it: a chart dragged into a corner and swelled must not come back in the middle, which is
   * the one thing a reader who presses this twice is checking for.
   */
  swell: (full) =>
    set((state) =>
      full
        ? { full: true, wasAt: state.box, box: fullBox() }
        : { full: false, box: state.wasAt ?? state.box, wasAt: null },
    ),
}));

/**
 * Escape puts it back.
 *
 * Anything that lifts itself over the page has to close on Escape, or a reader who did it by
 * accident is hunting for the control that undoes it.
 */
export function useEscapeFromZoom() {
  const zoomed = useZoomStore((state) => state.zoomed);
  const close = useZoomStore((state) => state.close);

  useEffect(() => {
    if (!zoomed) return;

    const listen = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };

    window.addEventListener('keydown', listen);

    return () => window.removeEventListener('keydown', listen);
  }, [zoomed, close]);
}

/**
 * A chart filling the screen follows the screen.
 *
 * Held as a state rather than as the size it happens to have: a window resized while this is on
 * would otherwise leave the chart at the old viewport's measurements — a chart that filled the
 * screen until the reader touched the edge of theirs.
 */
export function useFullFollowsScreen() {
  const full = useZoomStore((state) => state.full);
  const place = useZoomStore((state) => state.place);

  useEffect(() => {
    if (!full) return;

    const settle = () => place(fullBox());

    window.addEventListener('resize', settle);

    return () => window.removeEventListener('resize', settle);
  }, [full, place]);
}
