import { useEffect } from 'react';
import { create } from 'zustand';
import { moved, openingBox, type Box } from './floating';

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
  toggle: () => void;
  close: () => void;
  place: (box: Box) => void;
};

export const useZoomStore = create<ZoomState>((set) => ({
  zoomed: false,
  box: null,

  // Kept when it closes, so a window put where the reader wanted it opens there again. Passed
  // through the move first: the viewport may have been resized since, and a window remembered
  // off the edge of it is a window with no bar to take hold of.
  toggle: () =>
    set((state) =>
      state.zoomed ? { zoomed: false } : { zoomed: true, box: state.box ? moved(state.box, 0, 0) : openingBox() },
    ),

  close: () => set({ zoomed: false }),
  place: (box) => set({ box }),
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
