import { PointerEventTypes, type Scene } from '@babylonjs/core';
import type { MeshRegistry } from './meshes';

/** Further than this between press and release is a camera drag, not a click. */
const CLICK_SLOP_PX = 4;

/** A click on an object selects it; a click on nothing clears the selection. Answers its own detach. */
export function attachPicking(scene: Scene, registry: MeshRegistry, onPick: (id: string | null) => void) {
  let downX = 0;
  let downY = 0;

  const observer = scene.onPointerObservable.add((info) => {
    const event = info.event as PointerEvent;
    if (event.button !== 0) return;

    if (info.type === PointerEventTypes.POINTERDOWN) {
      downX = event.clientX;
      downY = event.clientY;
      return;
    }
    if (info.type !== PointerEventTypes.POINTERUP) return;
    if (Math.hypot(event.clientX - downX, event.clientY - downY) > CLICK_SLOP_PX) return;

    const hit = scene.pick(scene.pointerX, scene.pointerY, (mesh) => mesh.isPickable && registry.idOf(mesh) !== undefined);
    onPick(hit?.hit ? (registry.idOf(hit.pickedMesh) ?? null) : null);
  });

  return () => scene.onPointerObservable.remove(observer);
}
