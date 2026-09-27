import { create } from 'zustand';
import type { FlowDto } from '../../types/api';
import { sameFlow } from './flowDocument';

/** Where each flow's draft is kept: this, then the flow's id. One key to a flow — see the store. */
export const DRAFT_PREFIX = 'mqttforge.flows.draft.';

/** Where the flow on screen is kept, in the tab's own sessionStorage. */
const CURRENT_KEY = 'mqttforge.flows.current';

/**
 * Where every draft was kept together, with the flow on screen, before each draft had a key of its
 * own: zustand's persist wrote `{ state: { drafts, current }, version: 0 }` here. Read once, moved,
 * and removed.
 */
const OLD_KEY = 'mqttforge.flows.drafts';

/**
 * The shape a draft is kept in: `{ version, flow }`. A draft kept in a newer shape was written by a
 * newer build of the console, in another tab or before a downgrade; it is left where it is, unread.
 */
const VERSION = 1;

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

/*
 * localStorage and sessionStorage when they can be had, and nothing when they cannot — a private
 * window, a browser set to block site data. Every access is caught: a page that cannot keep drafts
 * still edits and deploys, and its drafts live until the page is closed.
 */

type Area = () => Storage;
const local: Area = () => localStorage;
const session: Area = () => sessionStorage;

function read(area: Area, key: string): string | null {
  try {
    return area().getItem(key);
  } catch {
    return null;
  }
}

function write(area: Area, key: string, value: string | null) {
  try {
    if (value === null) area().removeItem(key);
    else area().setItem(key, value);
  } catch {
    // Nowhere to keep it.
  }
}

function keysOf(area: Area): string[] {
  try {
    const storage = area();
    return Array.from({ length: storage.length }, (_, at) => storage.key(at)).filter((key) => key !== null);
  } catch {
    return [];
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string => typeof value === 'string';

const isWholeNode = (node: unknown) =>
  isRecord(node) && isText(node.id) && isText(node.type) && Number.isFinite(node.x) && Number.isFinite(node.y) && isRecord(node.config);

const isWholeEdge = (edge: unknown) =>
  isRecord(edge) && [edge.id, edge.from, edge.fromPort, edge.to, edge.toPort].every(isText);

/**
 * Whether what storage handed back is a whole flow: everything the page reads of one, each of the
 * kind the page reads it as. The page wrote it, but storage outlives the build that wrote it, and a
 * hand in the devtools can write anything there. One draft short of a name took the whole page
 * down, on every open, since the flow on screen is kept too.
 */
function isWholeFlow(value: unknown): value is FlowDto {
  return (
    isRecord(value) &&
    isText(value.id) &&
    value.id !== '' &&
    isText(value.name) &&
    typeof value.enabled === 'boolean' &&
    Array.isArray(value.nodes) &&
    value.nodes.every(isWholeNode) &&
    Array.isArray(value.edges) &&
    value.edges.every(isWholeEdge)
  );
}

const keyOf = (flowId: string) => DRAFT_PREFIX + flowId;

const kept = (flow: FlowDto) => JSON.stringify({ version: VERSION, flow });

/**
 * What one key holds: its draft; `later` for a draft a newer build kept, which is left for it; or
 * null for anything else — nothing, text that is not a draft, a flow short of something, or one
 * kept under another flow's key — which no build can use.
 */
function draftIn(key: string, text: string | null): FlowDto | 'later' | null {
  if (text === null) return null;

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }

  if (!isRecord(value)) return null;
  if (typeof value.version === 'number' && value.version > VERSION) return 'later';

  return value.version === VERSION && isWholeFlow(value.flow) && keyOf(value.flow.id) === key ? value.flow : null;
}

/** Every draft storage holds, each under its own key. What no build can use is taken out on the way. */
function draftsKept(): Record<string, FlowDto> {
  const drafts: Record<string, FlowDto> = {};

  for (const key of keysOf(local)) {
    if (!key.startsWith(DRAFT_PREFIX)) continue;

    const draft = draftIn(key, read(local, key));
    if (draft === null) write(local, key, null);
    else if (draft !== 'later') drafts[draft.id] = draft;
  }

  return drafts;
}

/**
 * Moves what was kept all together under the old key to where it is kept now: each draft to a key
 * of its own, and the flow that was on screen to this tab. Only whole flows move, and a draft
 * already under its own key was written since, so it stays. The drafts that moved are handed back
 * as well, so a storage too full to take them still has them on screen for this visit.
 */
function moveOld(): Record<string, FlowDto> {
  const text = read(local, OLD_KEY);
  if (text === null) return {};

  let old: unknown = null;
  try {
    old = JSON.parse(text);
  } catch {
    // Nothing in it can be read, so there is nothing to move.
  }

  const state = isRecord(old) && isRecord(old.state) ? old.state : {};
  const drafts: Record<string, FlowDto> = {};

  for (const flow of Object.values(isRecord(state.drafts) ? state.drafts : {})) {
    if (!isWholeFlow(flow) || read(local, keyOf(flow.id)) !== null) continue;
    drafts[flow.id] = flow;
    write(local, keyOf(flow.id), kept(flow));
  }

  if (isText(state.current) && read(session, CURRENT_KEY) === null) write(session, CURRENT_KEY, state.current);
  write(local, OLD_KEY, null);
  return drafts;
}

const without = <T>(record: Record<string, T>, key: string): Record<string, T> =>
  Object.fromEntries(Object.entries(record).filter(([id]) => id !== key));

/**
 * What the page has changed and not deployed.
 *
 * The deployed flows are the server's, read through react-query; this holds only the difference.
 * A flow's draft is kept whole rather than as a list of changes, because Deploy sends a whole
 * flow and "Discard" means "back to what is running" — both are one assignment with whole flows.
 *
 * Each draft is kept under a key of its own, written the moment it changes — a reload or a closed
 * tab inside a pause would lose the edit that "a reload loses nothing" promises to keep — and only
 * the drafts that changed are written. Two tabs of one console share localStorage: when every write
 * was the whole set, a node picked in one tab wrote that tab's drafts over the other's, and took
 * them away. Each tab also takes in what the other writes, flow by flow, as the browser tells it.
 * Which flow is on screen, and which node is picked, stay each tab's own: the flow on screen is
 * kept in the tab's sessionStorage, which a reload keeps and another tab does not see.
 *
 * A factory, so a test can open a second tab on the same storage.
 */
export function createFlowDraftStore() {
  const moved = moveOld();

  const store = create<DraftState>()((set) => ({
    drafts: { ...moved, ...draftsKept() },
    current: read(session, CURRENT_KEY),
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
  }));

  // True while this store takes in another tab's write, which is already in storage.
  let hearing = false;

  store.subscribe((state, before) => {
    if (hearing) return;

    if (state.drafts !== before.drafts)
      for (const id of new Set([...Object.keys(before.drafts), ...Object.keys(state.drafts)])) {
        const draft = state.drafts[id];
        if (draft !== before.drafts[id]) write(local, keyOf(id), draft ? kept(draft) : null);
      }

    if (state.current !== before.current) write(session, CURRENT_KEY, state.current);
  });

  const hear = (event: StorageEvent) => {
    let ours = false;
    try {
      ours = event.storageArea === localStorage;
    } catch {
      // No storage, so nothing to hear.
    }
    if (!ours || (event.key !== null && !event.key.startsWith(DRAFT_PREFIX))) return;

    const { drafts } = store.getState();
    let next = drafts;

    if (event.key === null) {
      // Storage was cleared: what is left is what there is.
      next = draftsKept();
    } else {
      const id = event.key.slice(DRAFT_PREFIX.length);
      const draft = draftIn(event.key, event.newValue);
      if (draft === 'later') return;

      // A draft this tab already has, word for word, stays the object it is: what the page has
      // worked out about a flow is kept against its object.
      if (draft ? sameFlow(draft, drafts[id]) : !(id in drafts)) return;
      next = draft ? { ...drafts, [id]: draft } : without(drafts, id);
    }

    hearing = true;
    try {
      store.setState({ drafts: next });
    } finally {
      hearing = false;
    }
  };

  if (typeof window !== 'undefined') window.addEventListener('storage', hear);

  return store;
}

export const useFlowDraftStore = createFlowDraftStore();
