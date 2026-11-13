# 3D Studio — design

Date: 2026-11-13 · Status: approved approach (A), awaiting spec review

## Goal

Bring the DesignBox scene/assembly editor (`C:\IT\DesignBox`, vanilla JS + Babylon.js 9, ~9.3k lines in
one IIFE) into MQTT Forge as a native panel called **3D Studio**, so a user can build a 3D scene of a
machine or cell and later drive its joints from live MQTT values (a digital twin).

The port is a clean re-implementation in TypeScript, not an iframe. Where the DesignBox code has dirty
parts (duplicated helpers, drifted mappers, per-frame allocations, swallowed errors, leaky globals)
they are fixed on the way in, and every ported unit lands with tests. `C:\IT\DesignBox` is left
untouched as the reference implementation.

## Decomposition

The whole DesignBox feature set is ported, in five phases. Each phase gets its own plan, ends with the
app working and the tests green, and is merged on its own.

| Phase | Scope |
|---|---|
| **1. Core** (this spec, in detail) | Panel, engine, camera/navigation, primitives, materials, selection, move/rotate/scale gizmos, snapping and steps, display units, outliner, inspector (transform, material), undo/redo, multiple scenes saved on the server, import of DesignBox `sahne.json` |
| 2. Import/export | GLB/glTF/STL/OBJ import (unit dialog), STEP/IGES via lazy `occt-import-js` with the `.dbmesh` cache, GLB/STL/OBJ/JSON export |
| 3. Assembly | Groups, link hierarchy, pivots, revolute/linear joints with feature detection, poses and motion, collision lock (GJK/BVH), alignment guides, point snap, contact/ground |
| 4. Tools | Measure, dimensions/annotations, section plane, mate-to-face, footprint, box select, array, standard/ortho views and view cube, context menu, transparency, hide/freeze |
| 5. Live binding | Bind joints to MQTT topics/fields from the topic tree, raw→value map, a viewer mode of the panel, replacement for DesignBox's `postMessage` contract |

Phases 2–5 are only outlined here; each gets its own spec section/plan when it starts. The data model
in Phase 1 already reserves the fields later phases need (see *Scene document*), so loading a full
DesignBox scene in Phase 1 does not lose data — unsupported parts are kept and round-tripped, just not
drawn or edited yet.

## Architecture (approach A: imperative engine + React UI)

```
 React UI (ui/*)  ──reads/dispatches──▶  studioStore (zustand)  ◀── history (undo/redo)
                                              │  document + session
                                              ▼ subscribe
                                        StudioEngine (Babylon)  ──pointer/gizmo edits──▶ store actions
                                              │
                                     persistence (api/studio.ts) ⇄ StudioController ⇄ JsonStudioSceneStore
```

- **`StudioEngine`** — a framework-free class that owns the Babylon `Engine`, `Scene`, camera, lights,
  grid, gizmos and the render loop. `mount(canvas)` / `dispose()`; no globals, no `window.*`, no
  `document.getElementById`. It subscribes to the store and reconciles meshes against the document by
  object id (create / update transform & material / dispose). User manipulation (gizmo drag, pick)
  goes back through store actions, never by mutating meshes as the source of truth.
- **`studioStore`** — zustand store split into the **document** (what is saved: objects, groups,
  poses, annotations, settings) and the **session** (what is not: selection, tool mode, hover,
  camera). Replaces DesignBox's `mesh.metadata` + closure `var`s and the `typeof x !== 'undefined'`
  workarounds. Tool mode is one discriminated union, not six booleans.
- **`history`** — undo/redo over document snapshots. A commit is an explicit action at the end of a
  gesture (`beginGesture`/`endGesture` around a drag; one commit per discrete action), not a side
  effect of the save debounce as in DesignBox. Limit 100 steps. Snapshots share unchanged object
  records structurally (immutable updates), so no whole-scene `JSON.stringify` per commit.
- **Pure modules** (`geometry/`, `model/`, `units/`) have no Babylon or DOM imports and are unit-tested
  in Vitest/jsdom. Babylon-bound modules are tested against Babylon's `NullEngine`.
- **Babylon comes from npm** (`@babylonjs/core`, `@babylonjs/materials` as needed; loaders and
  serializers arrive in Phase 2), tree-shaken ES imports, inside the lazy chunk. Nothing is fetched from
  a CDN at runtime, so the desktop app works offline. The IBL environment file ships in `web/public/studio/`.

### Panel integration

- `features/panels.ts`: `PanelId` gains `'studio'`; `PANELS` gains
  `{ id: 'studio', label: '3D Studio', group: 'Tools', icon: Cube, beta: true }`. A `Cube` icon is added
  to `features/brand/icons.tsx` in the existing icon style.
- `App.tsx`: `PANEL_VIEWS.studio`, and `studio` joins the `wide='fill'` set.
- `features/studio/StudioPanel.tsx` follows `FlowsPanel.tsx`: stays in the main bundle,
  `lazy(() => import('./StudioPage'))` with `PageNotLoaded`, `PanelShell named stretch`,
  `ErrorBoundary` with the reload fallback, `Suspense` with "Loading the studio…".
- Closing the panel unmounts `StudioPage`, which calls `engine.dispose()` (WebGL context released,
  observers and listeners removed). Re-opening rebuilds from the store, so the open scene and the
  selection survive a close/re-open within the session.
- Keyboard shortcuts are attached to the studio's root element (focus-scoped), not `window`, so they
  never fire while the user types in another panel.

### Folder layout (`web/src/features/studio/`)

```
StudioPanel.tsx            lazy wrapper (main bundle)
StudioPage.tsx(+.module.css)  layout: toolbar / outliner / viewport / inspector
engine/   StudioEngine.ts, camera.ts, navigation.ts, rendering.ts (lights, shadows, grid, env),
          gizmos.ts, picking.ts, meshes.ts (reconcile), materials.ts, primitives.ts
model/    document.ts (types), sceneFile.ts (DesignBox sahne.json ⇄ document, versioned),
          ids.ts (one id generator), defaults.ts
geometry/ euler.ts (wrapAngle, nearestEuler), snap.ts, … (Phase 3 adds gjk.ts, bvh.ts, …)
units/    units.ts (one formatter that respects the display unit), evalExpr.ts
ui/       Toolbar, Palette, Outliner, Inspector (Transform, Material), SceneMenu, dialogs
studioStore.ts, history.ts, useStudioShortcuts.ts
```

`web/src/api/studio.ts` holds the client calls; keys go in `api/queryKeys.ts`.

## Scene document

The saved format is DesignBox's `sahne.json` shape, made explicit and versioned, so existing scenes
load directly and exported files stay readable by DesignBox where it matters.

```ts
interface StudioScene {
  version: 2                 // DesignBox wrote 1 and never read it; we read and migrate 1 → 2
  id: string; name: string; updatedAt: string
  settings: { displayUnit: 'mm'|'cm'|'m'|'in'; moveStep: number; rotateStep: number; snap: boolean }
  objects: StudioObject[]; groups: Group[]; poses: Pose[]; annotations: Annotation[]
}
interface StudioObject {
  id: string                 // DesignBox "pid"; stable across saves
  type: 'box'|'sphere'|'cylinder'|'cone'|'pyramid'|'torus'|'capsule'|'wall'|'model'
  name: string
  position: Vec3; rotation: Quat; euler: Vec3 /* radians */; scaling: Vec3
  color?: string; mat?: { metal: number; rough: number }; matOverride?: {...}
  model?: { key: string; ext: string; importScale?: number }   // blob lives on the server, not inline
  parentId?: string          // DesignBox "link" was an index into objects; we use ids
  groupId?: string; hidden?: boolean; frozen?: boolean; transparent?: boolean
  rotPivot?: Vec3; joint?: Joint
}
```

- Version 1 → 2 migration (pure, tested): `pid` → `id`, `link` index → `parentId`, inline `model` data URL
  → uploaded to the model store and replaced by `model.key`, the legacy DesignBox fields
  (`pivot !== 'center'`, missing `importScale`, unnamed joints, missing joint `type`) handled once here.
- Unknown or later-phase fields (joints, poses, annotations, groups) are typed now and preserved on
  round-trip even while Phase 1 does not draw or edit them.
- One `newId()` replaces DesignBox's six ad-hoc random-id generators.

## Persistence (server)

Following the existing Domain → Infrastructure → Application → API layering:

- **Domain**: `IStudioSceneStore` (`ListAsync`, `GetAsync(id)`, `SaveAsync(scene)`, `DeleteAsync(id)`),
  `IStudioModelStore` (`PutAsync(stream, ext) → key`, `OpenAsync(key)`, `ExistsAsync`, `DeleteUnusedAsync(keepKeys)`).
  The scene is stored as an opaque JSON document plus id/name/updatedAt — the server validates shape and
  size, not 3D semantics.
- **Infrastructure**: `JsonStudioSceneStore` — one file per scene under `studio/scenes/<id>.json`,
  written via `.tmp` + `File.Move(overwrite)` like `JsonColourRuleStore`, missing/corrupt → skipped and
  logged. `FileStudioModelStore` — `studio/models/<sha256>.<ext>`; the key is the content hash, so the
  same file uploaded twice is stored once.
- **Paths**: `StorePaths.Studio(config)` → `MqttForge:StudioPath` or beside `connection-settings.json`
  (desktop: `%APPDATA%\MQTTForge\studio\`).
- **API** — `StudioController`, `[Route("api/studio")]`:
  - `GET scenes` → `[{id, name, updatedAt}]`
  - `GET scenes/{id}` → scene · `PUT scenes/{id}` (validated, `RequestSizeLimit` 8 MB) → 204 ·
    `DELETE scenes/{id}` → 204 (then unused models are collected)
  - `POST models` (multipart, `RequestSizeLimit` 200 MB, allowed extensions only) → `{key}`
  - `GET models/{key}` → file with the right content type, `ETag`, immutable cache (content-addressed)
  - Validation with FluentValidation in `Api/Validation/`; errors as `ValidationProblemDetails`.
- Model garbage collection runs after a scene delete or save, removing model files no scene references
  (DesignBox's `gcModels`, server-side).
- `MqttForgeHost`: the static-file content-type provider gains a `.env` mapping so the studio's
  lighting file is not 404'd. Models are served by the controller, never as static files.
- OriginGuard already covers the non-GET calls; nothing new is exposed to other origins.

**Client saving**: autosave of the open scene, debounced (500 ms) after the document changes, with a
save-state indicator (Saved / Saving… / Not saved — retry). A failed save keeps the dirty document in
memory and says so; it is never silently dropped. Scene list, new, rename, duplicate and delete live
in a scene menu in the studio toolbar (Forge dialogs, not `prompt()`/`confirm()`).
"Import DesignBox scene…" reads a `sahne.json` file and runs the v1 → v2 migration, uploading its
inline models. Phase 1 has no mesh loaders yet, so `model` objects are drawn as a translucent grey
placeholder box at their transform, and the inspector says what it stands for (selectable, movable, saved with their `model.key` intact); Phase 2
replaces the placeholder with the real mesh.

## Phase 1 feature detail

- **Viewport**: ArcRotate camera with zoom-to-cursor, orbit around the selection, target kept above
  ground; lights, shadows fitted to the scene, adaptive grid, environment lighting, selection outline.
  Babylon-private APIs DesignBox used (`cam._projectionMatrix`, shader string patching) are replaced
  with public ones; where no public equivalent exists, the effect is dropped and noted in the plan.
- **Create**: palette of the eight primitives; click to add at the view centre on the ground.
- **Edit**: move / rotate / scale gizmos (W/E/R), world/local orientation, steps and snap, numeric
  entry in the inspector with unit-aware expressions (`evalExpr`, e.g. `10cm+2mm`), delete, duplicate,
  copy/paste, undo/redo (Ctrl+Z / Ctrl+Y).
- **Outliner**: list with search, select, rename, hide; groups/hierarchy displayed read-only until Phase 3.
- **Inspector**: name, transform, colour and PBR material preset.
- **Units**: one formatter honours the display unit everywhere (DesignBox had three, two of which ignored it).
- **UI**: English labels, Forge tokens and CSS Modules, light/dark via the existing appearance.

## Clean-ups carried into the port (Phase 1 portion)

- Merge duplicate helpers (`round`/`roundTo`, three length formatters, six id generators).
- One mapper between document and meshes (DesignBox's `deserialize` and `applyData` had drifted).
- No per-frame allocations in render observers; inspector updates come from store subscriptions, not
  a per-frame `syncInspector`.
- Constants named in one place (shadow map size, debounce, drag dead zone, epsilons).
- No empty `catch {}`: errors are either handled with a user-visible message or rethrown; storage
  failures surface in the save indicator.
- No `innerHTML` with interpolated text; no `window.designbox` sandbox API (tests import modules directly).

## Error handling

- Lazy chunk fails to load → the panel's existing "Stopped / reload" fallback.
- WebGL unavailable or context lost → an in-panel message; context restore rebuilds from the store.
- Scene fails to load / migrate → the scene list stays usable, the error names the scene and why.
- Model file missing on the server → the object is kept in the document with a "missing model"
  placeholder box, not dropped (DesignBox dropped it silently).
- Save failure → indicator shows "Not saved", retry button, and the document stays dirty.

## Testing

- **Frontend (Vitest)**: pure modules (units, evalExpr, euler/snap, ids, sceneFile migration with
  DesignBox fixtures), `studioStore` actions and `history` (gesture → one undo step, limit, redo
  invalidation), `StudioEngine` reconcile against `NullEngine` (create/update/dispose, dispose releases
  everything), UI components with Testing Library + msw (outliner, inspector, scene menu, save
  indicator states), panel registration (rail entry, lazy fallback), and the existing
  `namedClasses` / `a11ySweeps` sweeps passing for the new panel.
- **Backend (xUnit)**: `JsonStudioSceneStore` and `FileStudioModelStore` (round-trip, corrupt file,
  atomic write, content-hash dedup, GC), `StudioController` integration tests (CRUD, validation,
  size limits, model content types, OriginGuard on writes).
- **Manual check in the browser preview**: create, move, undo, reload page → scene restored; import a
  real DesignBox `sahne.json`.

## Out of scope for Phase 1

Model import/export, joints, collision, measuring tools and live MQTT binding (Phases 2–5). No
multi-user editing or conflict resolution: last write wins per scene.
