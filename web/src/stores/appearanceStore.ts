import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { CHART_DETAIL, CHART_DETAIL_DEFAULT, type ChartDetailId } from '../features/appearance/chart';
import { SCALE_DEFAULT, SCALES, type ScaleId } from '../lib/scale';
import { DEFAULTS as FONTS, MONO, SANS, SIZE, type MonoId, type SansId } from '../features/appearance/fonts';

export type AppearanceChoices = {
  sans: SansId;
  mono: MonoId;
  size: number;
  chart: ChartDetailId;
  /** Which range a chart opens on, for the runs whose peaks are not the whole point. */
  scale: ScaleId;
};

type AppearanceState = AppearanceChoices & {
  setSans: (id: SansId) => void;
  setMono: (id: MonoId) => void;
  setSize: (px: number) => void;
  setChart: (id: ChartDetailId) => void;
  setScale: (id: ScaleId) => void;
  reset: () => void;
};

export const STORAGE_KEY = 'mqttforge.appearance';

// The fonts' own defaults plus the chart's, which is where the two halves of 'appearance' meet.
export const DEFAULTS: AppearanceChoices = { ...FONTS, chart: CHART_DETAIL_DEFAULT, scale: SCALE_DEFAULT };

// Validates stored fields against the catalogue, since localStorage may hold a stale or hand-edited value.
export function sanitize(raw: unknown): AppearanceChoices {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ...DEFAULTS };

  const { sans, mono, size, chart, scale } = raw as Record<string, unknown>;

  return {
    sans: typeof sans === 'string' && sans in SANS ? (sans as SansId) : DEFAULTS.sans,
    mono: typeof mono === 'string' && mono in MONO ? (mono as MonoId) : DEFAULTS.mono,
    size:
      typeof size === 'number' && Number.isFinite(size)
        ? Math.min(SIZE.max, Math.max(SIZE.min, Math.round(size)))
        : DEFAULTS.size,
    chart:
      typeof chart === 'string' && chart in CHART_DETAIL ? (chart as ChartDetailId) : DEFAULTS.chart,
    scale: typeof scale === 'string' && scale in SCALES ? (scale as ScaleId) : DEFAULTS.scale,
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
      setChart: (chart) => set({ chart }),
      setScale: (scale) => set({ scale }),
      reset: () => set({ ...DEFAULTS }),
    }),
    {
      name: STORAGE_KEY,
      version: 2,
      partialize: ({ sans, mono, size, chart, scale }) => ({ sans, mono, size, chart, scale }),
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
