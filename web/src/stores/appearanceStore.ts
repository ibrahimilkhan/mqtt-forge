import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { DEFAULTS, MONO, SANS, SIZE, type MonoId, type SansId } from '../features/appearance/fonts';

export type AppearanceChoices = { sans: SansId; mono: MonoId; size: number };

type AppearanceState = AppearanceChoices & {
  setSans: (id: SansId) => void;
  setMono: (id: MonoId) => void;
  setSize: (px: number) => void;
  reset: () => void;
};

export const STORAGE_KEY = 'mqfaker.appearance';

// Anything may sit in localStorage: a hand-edited value, or an id a later build dropped.
// Every stored field is checked against the catalogue before it reaches the UI.
export function sanitize(raw: unknown): AppearanceChoices {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ...DEFAULTS };

  const { sans, mono, size } = raw as Record<string, unknown>;

  return {
    sans: typeof sans === 'string' && sans in SANS ? (sans as SansId) : DEFAULTS.sans,
    mono: typeof mono === 'string' && mono in MONO ? (mono as MonoId) : DEFAULTS.mono,
    size:
      typeof size === 'number' && Number.isFinite(size)
        ? Math.min(SIZE.max, Math.max(SIZE.min, Math.round(size)))
        : DEFAULTS.size,
  };
}

// Client state, like hubStatusStore: nothing here is fetched, so it belongs in a store
// rather than in the query cache. Only the three choices are persisted — the CSS stacks
// are derived from the catalogue, so editing the catalogue cannot leave a stale font
// string behind in someone's browser.
export const useAppearanceStore = create<AppearanceState>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      setSans: (sans) => set({ sans }),
      setMono: (mono) => set({ mono }),
      setSize: (size) => set({ size }),
      reset: () => set({ ...DEFAULTS }),
    }),
    {
      name: STORAGE_KEY,
      version: 1,
      partialize: ({ sans, mono, size }) => ({ sans, mono, size }),
      merge: (persisted, current) => ({ ...current, ...sanitize(persisted) }),
      // Without this a future version bump would discard the stored choice; sanitize already
      // copes with any shape, so migrating is strictly better than falling back to defaults.
      migrate: (state) => sanitize(state),
      storage: createJSONStorage(() => {
        const ls = localStorage; // Throws when storage is blocked; createJSONStorage catches that.
        return {
          getItem: (key) => ls.getItem(key),
          // A failed write must not interrupt the workflow: the choice still applies to this tab.
          setItem: (key, value) => {
            try {
              ls.setItem(key, value);
            } catch {
              // Ignored on purpose — a full quota or a blocked write is not worth an error.
            }
          },
          removeItem: (key) => ls.removeItem(key),
        };
      }),
    },
  ),
);
