import { createStore, useStore, type StoreApi } from 'zustand';
import { quatFromEuler, wrapEuler, type Vec3 } from './geometry/euler';
import { record, redo, undo, type History } from './history';
import { newPrimitive, PRIMITIVE_LABELS } from './model/defaults';
import type { PrimitiveType, SceneSettings, StudioObject, StudioScene } from './model/document';
import { newId } from './model/ids';

/** The active gizmo the user may drag: select, or move/rotate/scale an object. */
export type Tool = 'select' | 'move' | 'rotate' | 'scale';
/** Which axis frame guides a gizmo: global space or the object's local frame. */
export type Orientation = 'world' | 'local';

/** Where a duplicate or a paste lands relative to its original: beside it, not inside it. */
const OFFSET: Vec3 = [0.5, 0, 0.5];

/**
 * The studio's state: the document that is saved, and the session around it that is not.
 *
 * This replaces DesignBox's mesh.metadata and its dozen closure variables, several declared `var`
 * only so they could be read through `typeof x !== 'undefined'` before they existed. The engine
 * draws from here and writes back through the actions; the React side reads the same.
 *
 * Every document change goes through `commit`, which is what makes undo exact: a change outside a
 * gesture is one step, and a gesture — a gizmo drag — is one step however many moves it sent.
 */
export type StudioState = {
  scene: StudioScene | null;
  selection: string[];
  tool: Tool;
  orientation: Orientation;
  clipboard: StudioObject[];
  history: History;
  gestureBase: StudioScene | null;
  /** Counts document changes; the saver compares it with `savedRevision`. */
  revision: number;
  savedRevision: number;

  open: (scene: StudioScene, saved?: boolean) => void;
  close: () => void;
  addPrimitive: (type: PrimitiveType, at: Vec3) => string;
  updateObject: (id: string, patch: Partial<StudioObject>) => void;
  setEuler: (id: string, euler: Vec3) => void;
  rename: (id: string, name: string) => void;
  removeObjects: (ids: string[]) => void;
  duplicate: (ids: string[]) => string[];
  copy: (ids: string[]) => void;
  paste: () => string[];
  select: (ids: string[]) => void;
  setTool: (tool: Tool) => void;
  setOrientation: (orientation: Orientation) => void;
  updateSettings: (patch: Partial<SceneSettings>) => void;
  renameScene: (name: string) => void;
  beginGesture: () => void;
  endGesture: () => void;
  undo: () => void;
  redo: () => void;
  markSaved: (revision: number) => void;
};

/** True if the document has unsaved changes since the last save. */
export const isDirty = (state: Pick<StudioState, 'revision' | 'savedRevision'>) => state.revision !== state.savedRevision;

const plus = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/** "Box 3": one more than the highest number already used for that kind. */
function nextName(scene: StudioScene, label: string) {
  const pattern = new RegExp(`^${label} (\\d+)$`);
  const used = scene.objects.map((o) => Number(o.name.match(pattern)?.[1] ?? 0));
  return `${label} ${Math.max(0, ...used) + 1}`;
}

/** Returns a fresh studio state and actions; tests create their own store, the console uses the singleton. */
export function createStudioStore(): StoreApi<StudioState> {
  return createStore<StudioState>()((set, get) => {
    /** Replaces the document and records the step the change makes, unless a gesture is under way. */
    const commit = (change: (scene: StudioScene) => StudioScene, session: Partial<StudioState> = {}) => {
      const { scene, gestureBase, history, revision } = get();
      if (!scene) return;
      const next = change(scene);
      if (next === scene) return;
      set({
        ...session,
        scene: next,
        history: gestureBase ? history : record(history, scene),
        revision: revision + 1,
      });
    };

    /** Puts a step from the history in place, keeping only the selection that still exists. */
    const step = (move: typeof undo) => {
      const { history, scene, revision, selection, gestureBase } = get();
      // Mid-gesture the step the drag makes is not finished; going back past it would leave the
      // gesture's base pointing at a scene that is no longer the one before it.
      if (gestureBase || !scene) return;
      const next = move(history, scene);
      if (!next) return;
      const ids = new Set(next.scene.objects.map((o) => o.id));
      set({ scene: next.scene, history: next.history, revision: revision + 1, selection: selection.filter((id) => ids.has(id)) });
    };

    const mapObjects = (ids: Set<string>, change: (o: StudioObject) => StudioObject) => (scene: StudioScene) => ({
      ...scene,
      objects: scene.objects.map((o) => (ids.has(o.id) ? change(o) : o)),
    });

    const copies = (sources: StudioObject[], suffix: string) =>
      sources.map((o) => ({ ...o, id: newId(), name: suffix ? `${o.name} ${suffix}` : o.name, position: plus(o.position, OFFSET) }));

    return {
      scene: null,
      selection: [],
      tool: 'move',
      orientation: 'world',
      clipboard: [],
      history: { past: [], future: [] },
      gestureBase: null,
      revision: 0,
      savedRevision: 0,

      open: (scene, saved = true) =>
        set({
          scene,
          selection: [],
          history: { past: [], future: [] },
          gestureBase: null,
          revision: 0,
          savedRevision: saved ? 0 : -1,
        }),

      close: () => set({ scene: null, selection: [], history: { past: [], future: [] }, gestureBase: null }),

      addPrimitive: (type, at) => {
        const scene = get().scene;
        if (!scene) return '';
        const object = newPrimitive(type, scene.objects.length, at, nextName(scene, PRIMITIVE_LABELS[type]));
        commit((s) => ({ ...s, objects: [...s.objects, object] }), { selection: [object.id] });
        return object.id;
      },

      updateObject: (id, patch) => commit(mapObjects(new Set([id]), (o) => ({ ...o, ...patch }))),

      setEuler: (id, euler) => {
        const wrapped = wrapEuler(euler);
        commit(mapObjects(new Set([id]), (o) => ({ ...o, euler: wrapped, rotation: quatFromEuler(wrapped) })));
      },

      rename: (id, name) => {
        const trimmed = name.trim();
        if (trimmed) commit(mapObjects(new Set([id]), (o) => ({ ...o, name: trimmed })));
      },

      removeObjects: (ids) => {
        const gone = new Set(ids);
        commit((s) => ({ ...s, objects: s.objects.filter((o) => !gone.has(o.id)) }), {
          selection: get().selection.filter((id) => !gone.has(id)),
        });
      },

      duplicate: (ids) => {
        const scene = get().scene;
        if (!scene) return [];
        const made = copies(scene.objects.filter((o) => ids.includes(o.id)), 'copy');
        commit((s) => ({ ...s, objects: [...s.objects, ...made] }), { selection: made.map((o) => o.id) });
        return made.map((o) => o.id);
      },

      copy: (ids) => set({ clipboard: get().scene?.objects.filter((o) => ids.includes(o.id)) ?? [] }),

      paste: () => {
        const made = copies(get().clipboard, '');
        if (made.length === 0) return [];
        commit((s) => ({ ...s, objects: [...s.objects, ...made] }), { selection: made.map((o) => o.id), clipboard: made });
        return made.map((o) => o.id);
      },

      select: (ids) => set({ selection: ids }),
      setTool: (tool) => set({ tool }),
      setOrientation: (orientation) => set({ orientation }),

      updateSettings: (patch) => commit((s) => ({ ...s, settings: { ...s.settings, ...patch } })),

      renameScene: (name) => {
        const trimmed = name.trim();
        if (trimmed) commit((s) => ({ ...s, name: trimmed }));
      },

      beginGesture: () => set({ gestureBase: get().scene }),

      endGesture: () => {
        const { gestureBase, scene, history } = get();
        if (!gestureBase) return;
        set({ gestureBase: null, history: scene && scene !== gestureBase ? record(history, gestureBase) : history });
      },

      undo: () => step(undo),
      redo: () => step(redo),

      markSaved: (revision) => set({ savedRevision: revision }),
    };
  });
}

/** The console's one studio. Tests make their own with `createStudioStore`. */
export const studioStore = createStudioStore();

export const useStudio = <T,>(selector: (state: StudioState) => T): T => useStore(studioStore, selector);
