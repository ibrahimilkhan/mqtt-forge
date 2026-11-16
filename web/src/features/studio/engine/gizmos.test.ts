import { NullEngine, Scene, Vector3 } from '@babylonjs/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { blankScene } from '../model/defaults';
import { createStudioStore, type StudioState } from '../studioStore';
import type { StoreApi } from 'zustand';
import { GizmoBridge } from './gizmos';
import { MeshRegistry } from './meshes';

let engine: NullEngine;
let scene: Scene;
let registry: MeshRegistry;
let store: StoreApi<StudioState>;
let bridge: GizmoBridge;

// The gizmo drag plane and pointer intersect in `DragStartEndEvent`; the gesture only needs the
// start/end observables to fire, so the minimal shape they require is enough.
const dragEndEvent = { dragPlanePoint: Vector3.Zero(), pointerId: 0, pointerInfo: null };

beforeEach(() => {
  engine = new NullEngine();
  scene = new Scene(engine);
  registry = new MeshRegistry(scene);
  store = createStudioStore();
  store.getState().open(blankScene('Cell'));
});
afterEach(() => {
  bridge?.dispose();
  registry.dispose();
  scene.dispose();
  engine.dispose();
});

describe('GizmoBridge', () => {
  it('writes a drag back to the document as one undo step', () => {
    const id = store.getState().addPrimitive('box', [0, 0, 0]);
    registry.sync(store.getState().scene!.objects);
    bridge = new GizmoBridge(scene, registry, store);

    store.getState().select([id]);
    store.getState().setTool('move');
    bridge.update(store.getState());

    const positionGizmo = bridge.gizmos.positionGizmo;
    expect(positionGizmo).not.toBeNull();

    const mesh = registry.mesh(id)!;
    const before = [...mesh.position.asArray()];

    positionGizmo!.onDragStartObservable.notifyObservers(dragEndEvent);
    mesh.position.x = 2;
    positionGizmo!.onDragObservable.notifyObservers({
      delta: Vector3.Zero(),
      dragPlanePoint: Vector3.Zero(),
      dragPlaneNormal: Vector3.Up(),
      dragDistance: 2,
      pointerId: 0,
      pointerInfo: null,
    });
    positionGizmo!.onDragEndObservable.notifyObservers(dragEndEvent);

    const object = store.getState().scene!.objects.find((o) => o.id === id)!;
    expect(object.position[0]).toBe(2);

    store.getState().undo();
    const restored = store.getState().scene!.objects.find((o) => o.id === id)!;
    expect(restored.position).toEqual(before);
  });
});
