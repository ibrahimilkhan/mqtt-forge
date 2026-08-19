import { useEffect } from 'react';
import { create } from 'zustand';

/**
 * Whether the chart has been thrown open over the whole console.
 *
 * The chart lives in a third of a column that is itself a third of the window, which is the right
 * size for glancing at a run and the wrong size for reading one. Folding the two regions around
 * it helps and is two clicks; this is one, it reaches past the column into the space the tree and
 * the panel are using, and it goes back to exactly where it was.
 *
 * A store rather than state in the chart: the pane that has to become an overlay is the region
 * around it, and that is placed by the workspace, three components up.
 */
type ZoomState = { zoomed: boolean; toggle: () => void; close: () => void };

export const useZoomStore = create<ZoomState>((set) => ({
  zoomed: false,
  toggle: () => set((state) => ({ zoomed: !state.zoomed })),
  close: () => set({ zoomed: false }),
}));

/**
 * Escape puts it back.
 *
 * Anything that covers the whole window has to close on Escape, or the reader is hunting for a
 * control to undo something they may have done by accident.
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
