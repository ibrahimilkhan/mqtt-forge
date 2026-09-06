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
  /**
   * Whether an alert that asks for a tone gets one.
   *
   * Off by default: a tool that makes a noise the first time somebody opens it is a tool that
   * gets muted at the operating system and then never heard again, including on the day it had
   * something to say. The choice is kept here with the other choices; whether this page is
   * *allowed* to make a sound is a separate thing and deliberately not stored — see
   * `features/alerts/alertSound.ts`.
   */
  alertSound: boolean;
  /**
   * How much traffic the console may hold before it starts cutting runs back, in megabytes.
   *
   * Here with the other choices because it is the same kind of choice — a fact about this
   * reader's machine, stored in this browser, that nothing on the broker side knows or needs to.
   * What it actually bounds lives in the log store; this is only where the answer is kept, so
   * that it survives the panel being closed and the app being restarted.
   */
  loadMb: number;
};
type AppearanceState = AppearanceChoices & {
  setSans: (id: SansId) => void;
  setMono: (id: MonoId) => void;
  setSize: (px: number) => void;
  setScale: (id: ScaleId) => void;
  toggleReading: (id: ReadingId, shown: boolean) => void;
  setHealth: (shown: boolean) => void;
  setAlertSound: (on: boolean) => void;
  setLoadMb: (mb: number) => void;
  /** Back to the catalogue's own answer for every reading. */
  resetReadings: () => void;
  reset: () => void;
};

export const STORAGE_KEY = 'mqttforge.appearance';

/**
 * What the reader may choose to give the console, in megabytes.
 *
 * A list rather than a free number: the answer is a rough one — how much of this machine is the
 * console welcome to — and a box that takes 7 or 100000 invites both. Five hundred is the
 * default and the middle of the list, generous enough that an ordinary broker never reaches it.
 */
export const LOADS = [100, 250, 500, 1000, 2000] as const;
// The fonts' own defaults plus the chart's, which is where the two halves of 'appearance' meet.
export const DEFAULTS: AppearanceChoices = {
  ...FONTS,
  scale: SCALE_DEFAULT,
  readings: {},
  health: false,
  alertSound: false,
  loadMb: 500,
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

  const { sans, mono, size, scale, readings, health, alertSound, loadMb } = raw as Record<
    string,
    unknown
  >;

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
    // Field by field, which is what makes the version bump cheap: a store written by version 5
    // knows nothing of this one and keeps everything else it did know.
    alertSound: typeof alertSound === 'boolean' ? alertSound : DEFAULTS.alertSound,
    // Any of the offered sizes, and the default for anything else: a hand-edited 20000 here
    // would be a console promising memory the machine does not have.
    loadMb:
      typeof loadMb === 'number' && (LOADS as readonly number[]).includes(loadMb)
        ? loadMb
        : DEFAULTS.loadMb,
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
      setAlertSound: (alertSound) => set({ alertSound }),
      setLoadMb: (loadMb) => set({ loadMb }),
      toggleReading: (id, shown) =>
        set((state) => ({ readings: { ...state.readings, [id]: shown } })),
      resetReadings: () => set({ readings: {} }),
      reset: () => set({ ...DEFAULTS }),
    }),
    {
      name: STORAGE_KEY,
      // 7 since how much the console may hold joined the stored choices. `migrate` is
      // `sanitize`, which reads field by field — so a store written by 6 keeps its font, its
      // size, its scale, its readings, its health line and its sound, and gains the default
      // load.
      version: 7,
      partialize: ({ sans, mono, size, scale, readings, health, alertSound, loadMb }) => ({
        sans,
        mono,
        size,
        scale,
        readings,
        health,
        alertSound,
        loadMb,
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
