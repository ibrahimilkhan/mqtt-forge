import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type StudioLayout = {
  /** Whether the object tree floats over the scene's left edge. */
  treeOpen: boolean;
  /** Whether the inspector floats over the right edge — while something is selected; never without. */
  inspectorOpen: boolean;
};

type LayoutState = StudioLayout & {
  setTreeOpen: (open: boolean) => void;
  setInspectorOpen: (open: boolean) => void;
};

export const LAYOUT_KEY = 'mqttforge.studio.layout';

export const LAYOUT_DEFAULTS: StudioLayout = { treeOpen: true, inspectorOpen: true };

/** The stored answer, field by field: a hand-edited or stale value falls back to the default. */
function sanitize(raw: unknown): StudioLayout {
  if (typeof raw !== 'object' || raw === null) return { ...LAYOUT_DEFAULTS };
  const { treeOpen, inspectorOpen } = raw as Record<string, unknown>;
  return {
    treeOpen: typeof treeOpen === 'boolean' ? treeOpen : LAYOUT_DEFAULTS.treeOpen,
    inspectorOpen: typeof inspectorOpen === 'boolean' ? inspectorOpen : LAYOUT_DEFAULTS.inspectorOpen,
  };
}

/**
 * Which of the studio's floating panels are open: a preference of this reader on this machine, and
 * nothing the scene or the server has any business knowing, so it is kept in local storage beside
 * the console's appearance rather than in the scene document.
 *
 * Every touch of storage is guarded. A browser with storage blocked throws on reading it, not only
 * on writing, and a studio that would not open because a layout preference could not be read
 * would be a poor trade — so a refused read is no stored answer and a refused write is a choice
 * that holds for this visit only.
 */
export const useStudioLayout = create<LayoutState>()(
  persist(
    (set) => ({
      ...LAYOUT_DEFAULTS,
      setTreeOpen: (treeOpen) => set({ treeOpen }),
      setInspectorOpen: (inspectorOpen) => set({ inspectorOpen }),
    }),
    {
      name: LAYOUT_KEY,
      version: 1,
      partialize: ({ treeOpen, inspectorOpen }) => ({ treeOpen, inspectorOpen }),
      merge: (persisted, current) => ({ ...current, ...sanitize(persisted) }),
      storage: createJSONStorage(() => ({
        getItem: (key) => {
          try {
            return localStorage.getItem(key);
          } catch (error) {
            console.warn('The studio layout could not be read; the defaults stand in.', error);
            return null;
          }
        },
        setItem: (key, value) => {
          try {
            localStorage.setItem(key, value);
          } catch (error) {
            console.warn('The studio layout could not be kept; it holds until the page is closed.', error);
          }
        },
        removeItem: (key) => {
          try {
            localStorage.removeItem(key);
          } catch (error) {
            console.warn('The studio layout could not be cleared.', error);
          }
        },
      })),
    },
  ),
);
