import { GizmoManager, type Mesh, type Scene } from '@babylonjs/core';
import type { StoreApi } from 'zustand';
import { degToRad } from '../units/units';
import type { StudioState } from '../studioStore';
import type { MeshRegistry } from './meshes';
import { transformFromMesh } from './transform';

/** Scaling has no unit the user sets a step for, unlike move and rotate; a tenth is fine enough. */
const SCALE_SNAP = 0.1;

/** The drag observables a position, rotation or scale gizmo all expose, enough for `wire` to use. */
type DragSource = {
  onDragStartObservable: { add(fn: () => void): unknown };
  onDragObservable: { add(fn: () => void): unknown };
  onDragEndObservable: { add(fn: () => void): unknown };
};

/**
 * The move, rotate and scale handles on the selected object, and the way their drags reach the
 * store. A drag is a gesture: it opens one undo step when it starts and closes it when it ends, and
 * every move in between writes the mesh's transform back to the document.
 */
export class GizmoBridge {
  private readonly manager: GizmoManager;
  private readonly registry: MeshRegistry;
  private readonly store: StoreApi<StudioState>;
  private attached: { id: string; mesh: Mesh } | null = null;
  private readonly wired = new WeakSet<object>();

  constructor(scene: Scene, registry: MeshRegistry, store: StoreApi<StudioState>) {
    this.registry = registry;
    this.store = store;
    this.manager = new GizmoManager(scene);
    this.manager.usePointerToAttachGizmos = false;
  }

  update(state: StudioState) {
    const id = state.selection.length === 1 ? state.selection[0] : null;
    const mesh = id ? this.registry.mesh(id) : undefined;
    const object = id ? state.scene?.objects.find((o) => o.id === id) : undefined;
    const usable = mesh && object && !object.frozen && !object.hidden;

    this.attached = usable ? { id: id!, mesh } : null;
    this.manager.attachToMesh(usable ? mesh : null);

    this.manager.positionGizmoEnabled = state.tool === 'move';
    this.manager.rotationGizmoEnabled = state.tool === 'rotate';
    this.manager.scaleGizmoEnabled = state.tool === 'scale';

    const settings = state.scene?.settings;
    const { gizmos } = this.manager;
    if (gizmos.positionGizmo) {
      gizmos.positionGizmo.snapDistance = settings?.snap ? settings.moveStep : 0;
      gizmos.positionGizmo.updateGizmoRotationToMatchAttachedMesh = state.orientation === 'local';
      this.wire(gizmos.positionGizmo);
    }
    if (gizmos.rotationGizmo) {
      gizmos.rotationGizmo.snapDistance = settings?.snap ? degToRad(settings.rotateStep) : 0;
      gizmos.rotationGizmo.updateGizmoRotationToMatchAttachedMesh = state.orientation === 'local';
      this.wire(gizmos.rotationGizmo);
    }
    if (gizmos.scaleGizmo) {
      gizmos.scaleGizmo.snapDistance = settings?.snap ? SCALE_SNAP : 0;
      this.wire(gizmos.scaleGizmo);
    }
  }

  // Exposed for tests, and for later focus/keyboard work, to drive or inspect the gizmos directly.
  get gizmos() {
    return this.manager.gizmos;
  }

  dispose() {
    this.manager.dispose();
  }

  // Each gizmo is made the first time its tool is chosen, so its drags are hooked up then, once.
  private wire(gizmo: DragSource) {
    if (this.wired.has(gizmo)) return;
    this.wired.add(gizmo);

    gizmo.onDragStartObservable.add(() => this.store.getState().beginGesture());
    gizmo.onDragObservable.add(() => this.writeBack());
    gizmo.onDragEndObservable.add(() => {
      this.writeBack();
      this.store.getState().endGesture();
    });
  }

  private writeBack() {
    if (this.attached) this.store.getState().updateObject(this.attached.id, transformFromMesh(this.attached.mesh));
  }
}
