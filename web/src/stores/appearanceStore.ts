import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { READINGS, type ReadingId } from '../features/appearance/readings';
import { SCALE_DEFAULT, SCALES, type ScaleId } from '../lib/scale';
import { DEFAULTS as FONTS, MONO, SANS, SIZE, type MonoId, type SansId } from '../features/appearance/fonts';

export type AppearanceChoices = {
  sans: SansId;
  mono: MonoId;
  size: number;
  /** Which range a chart opens on, for the runs whose peaks are not the whole point. */
  scale: ScaleId;
  /** The mark at the top of the rail. Six were drawn and none of them is obviously the one. */
  /**
   * Only the readings the reader has actually switched; the rest follow the catalogue.
   *
   * Held this way round so that adding a reading in a later release does not need every stored
   * preference rewritten to know whether to draw it.
   */
  readings: Partial<Record<ReadingId, boolean>>;
  /**
   * Whether the line under the workspace saying what the console is carrying is shown.
   *
   * Off by default. It answers a question most readers never ask, and a row of numbers changing
   * every second at the foot of a tool whose whole manner is quiet is not what they came for.
   */
  health: boolean;
};

type AppearanceState = AppearanceChoices & {
  setSans: (id: SansId) => void;
  setMono: (id: MonoId) => void;
  setSize: (px: number) => void;
  setScale: (id: ScaleId) => void;
  toggleReading: (id: ReadingId, shown: boolean) => void;
  setHealth: (shown: boolean) => void;
  /** Back to the catalogue's own answer for every reading. */
  resetReadings: () => void;
  reset: () => void;
};

export const STORAGE_KEY = 'mqttforge.appearance';

// The fonts' own defaults plus the chart's, which is where the two halves of 'appearance' meet.
export const DEFAULTS: AppearanceChoices = {
  ...FONTS,
  scale: SCALE_DEFAULT,
  readings: {},
  health: false,
};

/** The stored switches, keeping only the ones that name a reading and say true or false. */
function switched(raw: unknown): Partial<Record<ReadingId, boolean>> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};

  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(
      ([id, shown]) => id in READINGS && typeof shown === 'boolean',
    ),
  );
}

// Validates stored fields against the catalogue, since localStorage may hold a stale or hand-edited value.
export function sanitize(raw: unknown): AppearanceChoices {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ...DEFAULTS };

  const { sans, mono, size, scale, readings, health } = raw as Record<string, unknown>;

  return {
    sans: typeof sans === 'string' && sans in SANS ? (sans as SansId) : DEFAULTS.sans,
    mono: typeof mono === 'string' && mono in MONO ? (mono as MonoId) : DEFAULTS.mono,
    size:
      typeof size === 'number' && Number.isFinite(size)
        ? Math.min(SIZE.max, Math.max(SIZE.min, Math.round(size)))
        : DEFAULTS.size,
    scale: typeof scale === 'string' && scale in SCALES ? (scale as ScaleId) : DEFAULTS.scale,
    readings: switched(readings),
    health: typeof health === 'boolean' ? health : DEFAULTS.health,
  };
}

// Client state, not fetched, so a store rather than the query cache. Only the stored
// choices persist; CSS stacks are derived from the catalogue at read time.
export const useAppearanceStore = create<AppearanceState>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      setSans: (sans) => set({ sans }),
      setMono: (mono) => set({ mono }),
      setSize: (size) => set({ size }),
      setScale: (scale) => set({ scale }),
      setHealth: (health) => set({ health }),
      toggleReading: (id, shown) =>
        set((state) => ({ readings: { ...state.readings, [id]: shown } })),
      resetReadings: () => set({ readings: {} }),
      reset: () => set({ ...DEFAULTS }),
    }),
    {
      name: STORAGE_KEY,
      version: 5,
      partialize: ({ sans, mono, size, scale, readings, health }) => ({
        sans,
        mono,
        size,
        scale,
        readings,
        health,
      }),
      merge: (persisted, current) => ({ ...current, ...sanitize(persisted) }),
      // Migrates rather than discarding on version bump; sanitize handles any shape.
      migrate: (state) => sanitize(state),
      storage: createJSONStorage(() => {
        const ls = localStorage; // May throw if storage is blocked; createJSONStorage catches it.
        return {
          getItem: (key) => ls.getItem(key),
          // A failed write shouldn't break the tab; the choice still applies in memory.
          setItem: (key, value) => {
            try {
              ls.setItem(key, value);
            } catch {
              // Ignored: a full quota or blocked write isn't worth surfacing.
            }
          },
          removeItem: (key) => ls.removeItem(key),
        };
      }),
    },
  ),
);
