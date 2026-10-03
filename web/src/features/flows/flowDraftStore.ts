import { create } from 'zustand';
import type { FlowDto } from '../../types/api';
import { fingerprint, sameFlow } from './flowDocument';

/** Where each flow's draft is kept: this, then the flow's id. One key to a flow — see the store. */
export const DRAFT_PREFIX = 'mqttforge.flows.draft.';

/** Where the flow on screen is kept, in the tab's own sessionStorage. */
const CURRENT_KEY = 'mqttforge.flows.current';

/**
 * The shape a draft is kept in: `{ version, flow, base }`. A
 * draft kept in a newer shape was written by a newer build of the console, in another tab or before
 * a downgrade; it is left where it is, unread.
 */
const VERSION = 1;

type DraftState = {
  /** Flows edited here and not yet deployed, by id — flows never deployed included. */
  drafts: Record<string, FlowDto>;
  /**
   * The copy on the server each draft was started from, as flowDocument's fingerprint of it; null
   * for a flow started here, which the server never had. The server sends no version of a flow, so
   * this is how the page tells a draft of the copy the server has from one of a copy it has since
   * replaced (see standingOf). Every draft has one.
   */
  bases: Record<string, string | null>;
  /** The flow on screen. */
  current: string | null;
  /** The node the inspector is showing. Null shows the flow's own settings. */
  selected: string | null;
  /** What the server said about each flow's last refused deploy: flow id, then flow / node:{id} / edge:{id}. */
  refusals: Record<string, Record<string, string[]>>;
  /**
   * This browser would not keep a draft — its storage is full, or site data is blocked — so a
   * reload brings back older drafts than the ones on screen, or none. Set by the first draft it
   * refuses, and not cleared: what it kept before then is still what a reload finds.
   */
  unkept: boolean;

  /** Changes a flow, starting its draft from `base` — the copy on screen, the server's — if it has none yet. */
  edit: (base: FlowDto, change: (flow: FlowDto) => FlowDto) => void;
  /**
   * A whole draft, of the copy on the server `base` fingerprints: null, the default, for a new flow
   * or an example, which the server has never had.
   */
  put: (flow: FlowDto, base?: string | null) => void;
  /**
   * These drafts hold nothing of the reader's any more — the server has them now, or they say what
   * it has (see standingOf) — and go, with their refusals. Unlike a discard, the flow on screen and
   * the node picked stay: the reader is where they were, looking at the same flow, which is now
   * simply the server's copy.
   */
  settle: (flowIds: readonly string[]) => void;
  /** The draft now counts as made on the copy `base` fingerprints: the reader chose to keep it over that copy. */
  rebase: (flowId: string, base: string | null) => void;
  /**
   * Throws a flow's draft away: its edits, or the whole flow once it has been deleted. Clears the
   * selection too, but only if this is the flow on screen.
   */
  discard: (id: string) => void;
  show: (id: string | null) => void;
  select: (nodeId: string | null) => void;
  refuse: (flowId: string, errors: Record<string, string[]>) => void;
  /**
   * These flows have no draft any more. A refusal is the server's answer about one draft, not
   * about a flow, and that draft is no longer there to be refused, so the refusals go.
   */
  lapse: (flowIds: readonly string[]) => void;
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

/** Whether it was kept. */
function write(area: Area, key: string, value: string | null): boolean {
  try {
    if (value === null) area().removeItem(key);
    else area().setItem(key, value);
    return true;
  } catch {
    // Nowhere to keep it.
    return false;
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

const isWholeVariable = (variable: unknown) => isRecord(variable) && isText(variable.name) && isText(variable.value);

/**
 * Whether what storage handed back is a whole flow: everything the page reads of one, each of the
 * kind the page reads it as. The page wrote it, but storage outlives the build that wrote it, and a
 * hand in the devtools can write anything there. One draft short of a name took the whole page
 * down, on every open, since the flow on screen is kept too.
 *
 * Variables are part of a whole flow. A draft kept before flows had them came from a build that was
 * never released, so nothing makes it whole: it goes like any other draft that is not.
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
    value.edges.every(isWholeEdge) &&
    Array.isArray(value.variables) &&
    value.variables.every(isWholeVariable)
  );
}

const keyOf = (flowId: string) => DRAFT_PREFIX + flowId;

/** A draft as it is kept: the flow, and the copy on the server it was started from. */
type Kept = { flow: FlowDto; base: string | null };

const kept = (flow: FlowDto, base: string | null) => JSON.stringify({ version: VERSION, flow, base });

/**
 * What one key holds: its draft; `later` for a draft a newer build kept, which is left for it; or
 * null for anything else — nothing, text that is not a draft, a flow short of something or of its
 * start, or one kept under another flow's key — which no build can use.
 */
function draftIn(key: string, text: string | null): Kept | 'later' | null {
  if (text === null) return null;

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }

  if (!isRecord(value)) return null;
  if (typeof value.version === 'number' && value.version > VERSION) return 'later';
  if (value.version !== VERSION || !isWholeFlow(value.flow) || keyOf(value.flow.id) !== key) return null;
  if (value.base !== null && !isText(value.base)) return null;

  return { flow: value.flow, base: value.base };
}

/** Every draft storage holds, each under its own key. What no build can use is taken out on the way. */
function draftsKept(): Pick<DraftState, 'drafts' | 'bases'> {
  const drafts: Record<string, FlowDto> = {};
  const bases: Record<string, string | null> = {};

  for (const key of keysOf(local)) {
    if (!key.startsWith(DRAFT_PREFIX)) continue;

    const draft = draftIn(key, read(local, key));
    if (draft === null) write(local, key, null);
    else if (draft !== 'later') {
      drafts[draft.flow.id] = draft.flow;
      bases[draft.flow.id] = draft.base;
    }
  }

  return { drafts, bases };
}

const without = <T>(record: Record<string, T>, ...keys: readonly string[]): Record<string, T> =>
  Object.fromEntries(Object.entries(record).filter(([id]) => !keys.includes(id)));

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
  const stored = draftsKept();

  const store = create<DraftState>()((set) => ({
    drafts: stored.drafts,
    bases: stored.bases,
    current: read(session, CURRENT_KEY),
    selected: null,
    refusals: {},
    unkept: false,

    edit: (base, change) =>
      set((state) => {
        const draft = state.drafts[base.id];
        return {
          drafts: { ...state.drafts, [base.id]: change(draft ?? base) },
          // A new draft is of the copy it was started from; one already here stays of the copy it was.
          bases: draft === undefined ? { ...state.bases, [base.id]: fingerprint(base) } : state.bases,
        };
      }),

    put: (flow, base = null) =>
      set((state) => ({ drafts: { ...state.drafts, [flow.id]: flow }, bases: { ...state.bases, [flow.id]: base } })),

    settle: (flowIds) =>
      set((state) => ({
        drafts: without(state.drafts, ...flowIds),
        bases: without(state.bases, ...flowIds),
        refusals: without(state.refusals, ...flowIds),
      })),

    rebase: (flowId, base) => set((state) => ({ bases: { ...state.bases, [flowId]: base } })),

    discard: (id) =>
      set((state) => ({
        drafts: without(state.drafts, id),
        bases: without(state.bases, id),
        refusals: without(state.refusals, id),
        // A selection belongs to whatever canvas is open; discarding some other flow's draft
        // must not blank out what the reader is looking at right now.
        selected: state.current === id ? null : state.selected,
      })),

    show: (id) => set({ current: id, selected: null }),

    select: (nodeId) => set({ selected: nodeId }),

    refuse: (flowId, errors) => set((state) => ({ refusals: { ...state.refusals, [flowId]: errors } })),

    lapse: (flowIds) => set((state) => ({ refusals: without(state.refusals, ...flowIds) })),
  }));

  // True while this store takes in another tab's write, which is already in storage.
  let hearing = false;

  store.subscribe((state, before) => {
    if (hearing) return;

    let refused = false;
    if (state.drafts !== before.drafts || state.bases !== before.bases)
      for (const id of new Set([...Object.keys(before.drafts), ...Object.keys(state.drafts)])) {
        const draft = state.drafts[id];
        const base = state.bases[id] ?? null;
        if (draft === before.drafts[id] && base === (before.bases[id] ?? null)) continue;

        if (!write(local, keyOf(id), draft ? kept(draft, base) : null)) refused = true;
      }

    if (state.current !== before.current) write(session, CURRENT_KEY, state.current);

    // Said once. A full storage refuses every keystroke after the first, and the page is told
    // the first time.
    if (refused && !state.unkept) store.setState({ unkept: true });
  });

  const hear = (event: StorageEvent) => {
    let ours = false;
    try {
      ours = event.storageArea === localStorage;
    } catch {
      // No storage, so nothing to hear.
    }
    if (!ours || (event.key !== null && !event.key.startsWith(DRAFT_PREFIX))) return;

    const { drafts, bases } = store.getState();
    let next: Pick<DraftState, 'drafts' | 'bases'>;

    if (event.key === null) {
      // Storage was cleared: what is left is what there is.
      next = draftsKept();
    } else {
      const id = event.key.slice(DRAFT_PREFIX.length);
      const draft = draftIn(event.key, event.newValue);
      if (draft === 'later') return;

      if (draft === null) {
        if (!(id in drafts)) return;
        next = { drafts: without(drafts, id), bases: without(bases, id) };
      } else {
        // A draft this tab already has, word for word, stays the object it is: what the page has
        // worked out about a flow is kept against its object.
        const same = sameFlow(draft.flow, drafts[id]);
        if (same && draft.base === bases[id]) return;
        next = { drafts: same ? drafts : { ...drafts, [id]: draft.flow }, bases: { ...bases, [id]: draft.base } };
      }
    }

    hearing = true;
    try {
      store.setState(next);
    } finally {
      hearing = false;
    }
  };

  if (typeof window !== 'undefined') window.addEventListener('storage', hear);

  return store;
}

export const useFlowDraftStore = createFlowDraftStore();
