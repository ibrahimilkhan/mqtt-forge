import { create } from 'zustand';
import { own } from '../../lib/own';
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
  /** Flows edited here and not yet saved, by id — flows never saved included. */
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
  /**
   * The one wire picked, when a wire and nothing else is: where the palette puts the node it adds.
   * Not kept: like `selected`, it is about what is on screen now.
   */
  wire: string | null;
  /**
   * What the server said, the last time it refused a flow, of what it was sent: flow id, then flow /
   * node:{id} / edge:{id}. What it was sent is the flow's draft, or — for a Test or an Activate of a
   * flow with none — the server's own copy. A refusal of a draft goes with that draft, however the
   * draft goes.
   */
  refusals: Record<string, Record<string, string[]>>;
  /**
   * For a refusal of the server's own copy of a flow — tested, or activated, with no draft — that
   * copy's fingerprint. Such a refusal is about the copy, not about anything drawn here, and has no
   * draft to go with: it lapses once the server has another copy, or none. Only the page reads the
   * list, so it is the page that tells the store, through lapse.
   */
  refusedCopies: Record<string, string>;
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
   * selection and the wire picked too, but only if this is the flow on screen.
   */
  discard: (id: string) => void;
  show: (id: string | null) => void;
  /**
   * Shows a node in the inspector, or with null the flow's own settings. A node chosen is picked on
   * the canvas, so no wire is picked alone any more.
   */
  select: (nodeId: string | null) => void;
  /** The canvas says which wire is picked: its id when exactly one wire and no node is, or null. */
  pickWire: (edgeId: string | null) => void;
  /**
   * Files what the server said when it refused `sent`: the flow's draft, when `drafted` says the
   * flow had one as the request went, or else the server's own copy of a flow with none, which is
   * filed against that copy (see refusedCopies). A draft let go while the request was out — on
   * another tab, or taken back — has nothing left for the answer to be about, and nothing is filed:
   * marked on the copy the page shows in its place, it would say the server refused a flow nobody
   * sent. A test and every save of a drawing file theirs here, so the rule is kept in one place.
   */
  refuse: (sent: FlowDto, drafted: boolean, errors: Record<string, string[]>) => void;
  /**
   * What the server refused of these flows is no longer what is there: a test of each has started
   * since, so the drawing it refused is not the one running now; or the server's copy it refused
   * has since been replaced, or deleted. The drafts stay.
   */
  lapse: (flowIds: readonly string[]) => void;
};

/*
 * localStorage and sessionStorage when they can be had, and nothing when they cannot — a private
 * window, a browser set to block site data. Every access is caught: a page that cannot keep drafts
 * still edits, tests and saves, and its drafts live until the page is closed.
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

/**
 * Every draft storage holds, each under its own key. What no build can use is taken out on the way.
 * Made records whose every key is its own, as every record of the store is (see own).
 */
function draftsKept(): Pick<DraftState, 'drafts' | 'bases'> {
  const found: Kept[] = [];

  for (const key of keysOf(local)) {
    if (!key.startsWith(DRAFT_PREFIX)) continue;

    const draft = draftIn(key, read(local, key));
    if (draft === null) write(local, key, null);
    else if (draft !== 'later') found.push(draft);
  }

  return {
    drafts: Object.fromEntries(found.map(({ flow }) => [flow.id, flow])),
    bases: Object.fromEntries(found.map(({ flow, base }) => [flow.id, base])),
  };
}

const without = <T>(record: Record<string, T>, ...keys: readonly string[]): Record<string, T> =>
  Object.fromEntries(Object.entries(record).filter(([id]) => !keys.includes(id)));

/** These flows' refusals gone, and with them which copies of the server's any of them was of. */
const unrefused = (state: Pick<DraftState, 'refusals' | 'refusedCopies'>, flowIds: readonly string[]) => ({
  refusals: without(state.refusals, ...flowIds),
  refusedCopies: without(state.refusedCopies, ...flowIds),
});

/**
 * What the page has changed and not saved.
 *
 * The saved flows are the server's, read through react-query; this holds only the difference.
 * A flow's draft is kept whole rather than as a list of changes, because Test and Activate send a
 * whole flow and "Discard" means "back to what is saved" — each is one assignment with whole flows.
 *
 * Each draft is kept under a key of its own, written the moment it changes — a reload or a closed
 * tab inside a pause would lose the edit that "a reload loses nothing" promises to keep — and only
 * the drafts that changed are written. Two tabs of one console share localStorage: when every write
 * was the whole set, a node picked in one tab wrote that tab's drafts over the other's, and took
 * them away. Each tab also takes in what the other writes, flow by flow, as the browser tells it.
 * Which flow is on screen, and which node is picked, stay each tab's own: the flow on screen is
 * kept in the tab's sessionStorage, which a reload keeps and another tab does not see.
 *
 * Every record here is kept by flow id, and a flow can be called what every object answers to: each
 * is read through own, and written by a computed key, a spread or Object.fromEntries (see own).
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
    wire: null,
    refusals: {},
    refusedCopies: {},
    unkept: false,

    edit: (base, change) =>
      set((state) => {
        const draft = own(state.drafts, base.id);
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
        ...unrefused(state, flowIds),
      })),

    rebase: (flowId, base) => set((state) => ({ bases: { ...state.bases, [flowId]: base } })),

    discard: (id) =>
      set((state) => ({
        drafts: without(state.drafts, id),
        bases: without(state.bases, id),
        ...unrefused(state, [id]),
        // A selection belongs to whatever canvas is open; discarding some other flow's draft
        // must not blank out what the reader is looking at right now.
        selected: state.current === id ? null : state.selected,
        wire: state.current === id ? null : state.wire,
      })),

    show: (id) => set({ current: id, selected: null, wire: null }),

    select: (nodeId) => set(nodeId === null ? { selected: null } : { selected: nodeId, wire: null }),

    pickWire: (wire) => set({ wire }),

    refuse: (sent, drafted, errors) =>
      set((state) =>
        drafted && !Object.hasOwn(state.drafts, sent.id)
          ? state
          : {
              refusals: { ...state.refusals, [sent.id]: errors },
              // Of the server's copy, it goes with that copy; of a draft, with the draft.
              refusedCopies: drafted
                ? without(state.refusedCopies, sent.id)
                : { ...state.refusedCopies, [sent.id]: fingerprint(sent) },
            },
      ),

    lapse: (flowIds) => set((state) => unrefused(state, flowIds)),
  }));

  // True while this store takes in another tab's write, which is already in storage.
  let hearing = false;

  store.subscribe((state, before) => {
    if (hearing) return;

    let refused = false;
    if (state.drafts !== before.drafts || state.bases !== before.bases)
      for (const id of new Set([...Object.keys(before.drafts), ...Object.keys(state.drafts)])) {
        const draft = own(state.drafts, id);
        const base = own(state.bases, id) ?? null;
        if (draft === own(before.drafts, id) && base === (own(before.bases, id) ?? null)) continue;

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

    const { drafts, bases, refusals, refusedCopies } = store.getState();
    let next: Pick<DraftState, 'drafts' | 'bases'>;

    if (event.key === null) {
      // Storage was cleared: what is left is what there is.
      next = draftsKept();
    } else {
      const id = event.key.slice(DRAFT_PREFIX.length);
      const draft = draftIn(event.key, event.newValue);
      if (draft === 'later') return;

      if (draft === null) {
        if (!Object.hasOwn(drafts, id)) return;
        next = { drafts: without(drafts, id), bases: without(bases, id) };
      } else {
        // A draft this tab already has, word for word, stays the object it is: what the page has
        // worked out about a flow is kept against its object.
        const same = sameFlow(draft.flow, own(drafts, id));
        if (same && draft.base === own(bases, id)) return;
        next = { drafts: same ? drafts : { ...drafts, [id]: draft.flow }, bases: { ...bases, [id]: draft.base } };
      }
    }

    // A refusal of a draft the other tab let go has nothing left to be about, and goes with it, as it
    // goes with a draft let go here. One of the server's copy of a flow with no draft had none to go.
    const gone = Object.keys(drafts).filter((id) => !Object.hasOwn(next.drafts, id) && Object.hasOwn(refusals, id));

    hearing = true;
    try {
      store.setState(gone.length > 0 ? { ...next, ...unrefused({ refusals, refusedCopies }, gone) } : next);
    } finally {
      hearing = false;
    }
  };

  if (typeof window !== 'undefined') window.addEventListener('storage', hear);

  return store;
}

export const useFlowDraftStore = createFlowDraftStore();
