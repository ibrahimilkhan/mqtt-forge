import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import type { FlowDto } from '../../types/api';

export const DRAFTS_KEY = 'mqttforge.flows.drafts';

type DraftState = {
  /** Flows edited here and not yet deployed, by id — flows never deployed included. */
  drafts: Record<string, FlowDto>;
  /** The flow on screen. */
  current: string | null;
  /** The node the inspector is showing. Null shows the flow's own settings. */
  selected: string | null;
  /** What the server said about each flow's last refused deploy: flow id, then flow / node:{id} / edge:{id}. */
  refusals: Record<string, Record<string, string[]>>;

  /** Changes a flow, starting its draft from `base` if it has none yet. */
  edit: (base: FlowDto, change: (flow: FlowDto) => FlowDto) => void;
  /** A whole draft: a new flow, or an example. */
  put: (flow: FlowDto) => void;
  /** Throws a flow's edits away. Clears the selection too, but only if this is the flow on screen. */
  discard: (id: string) => void;
  show: (id: string | null) => void;
  select: (nodeId: string | null) => void;
  refuse: (flowId: string, errors: Record<string, string[]>) => void;
  /**
   * These flows match what is running again. A refusal is the server's answer about one draft, not
   * about a flow, and that draft is no longer there to be refused, so the refusals go.
   */
  lapse: (flowIds: readonly string[]) => void;
  /** The server has the flow now; there is nothing left to keep here. */
  deployed: (flowId: string) => void;
  /** The flow was deleted. */
  forget: (flowId: string) => void;
};

/**
 * localStorage when it can be had, and nothing when it cannot — a private window, a browser set to
 * block site data. Every access is caught: a page that cannot keep drafts still edits and deploys.
 * Written the moment a change happens rather than after a pause: the persist middleware has already
 * turned the whole state into one JSON string before this runs, so the only thing a delay would
 * save is the localStorage call itself — and a reload or a closed tab inside that delay would lose
 * the edit that "a reload loses nothing" promises to keep.
 */
const quietly: StateStorage = {
  getItem: (name) => {
    try {
      return localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    try {
      localStorage.setItem(name, value);
    } catch {
      // Nowhere to keep it. The draft lives until the page is closed.
    }
  },
  removeItem: (name) => {
    try {
      localStorage.removeItem(name);
    } catch {
      // As above.
    }
  },
};

const without = <T>(record: Record<string, T>, key: string): Record<string, T> =>
  Object.fromEntries(Object.entries(record).filter(([id]) => id !== key));

/**
 * What the page has changed and not deployed.
 *
 * The deployed flows are the server's, read through react-query; this holds only the difference.
 * A flow's draft is kept whole rather than as a list of changes, because Deploy sends a whole
 * flow and "Discard" means "back to what is running" — both are one assignment with whole flows.
 */
export const useFlowDraftStore = create<DraftState>()(
  persist(
    (set) => ({
      drafts: {},
      current: null,
      selected: null,
      refusals: {},

      edit: (base, change) =>
        set((state) => ({ drafts: { ...state.drafts, [base.id]: change(state.drafts[base.id] ?? base) } })),

      put: (flow) => set((state) => ({ drafts: { ...state.drafts, [flow.id]: flow } })),

      discard: (id) =>
        set((state) => ({
          drafts: without(state.drafts, id),
          refusals: without(state.refusals, id),
          // A selection belongs to whatever canvas is open; discarding some other flow's draft
          // must not blank out what the reader is looking at right now.
          selected: state.current === id ? null : state.selected,
        })),

      show: (id) => set({ current: id, selected: null }),

      select: (nodeId) => set({ selected: nodeId }),

      refuse: (flowId, errors) => set((state) => ({ refusals: { ...state.refusals, [flowId]: errors } })),

      lapse: (flowIds) =>
        set((state) => ({
          refusals: Object.fromEntries(Object.entries(state.refusals).filter(([id]) => !flowIds.includes(id))),
        })),

      deployed: (flowId) =>
        set((state) => ({ drafts: without(state.drafts, flowId), refusals: without(state.refusals, flowId) })),

      forget: (flowId) =>
        set((state) => ({
          drafts: without(state.drafts, flowId),
          refusals: without(state.refusals, flowId),
          current: state.current === flowId ? null : state.current,
          selected: state.current === flowId ? null : state.selected,
        })),
    }),
    {
      name: DRAFTS_KEY,
      storage: createJSONStorage(() => quietly),
      // Only the work and where it was left. A refusal is about a deploy that happened in this
      // page, and a selection about a canvas that is not open yet.
      partialize: (state) => ({ drafts: state.drafts, current: state.current }),
    },
  ),
);
