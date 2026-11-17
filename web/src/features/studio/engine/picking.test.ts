import { NullEngine, PointerEventTypes, PointerInfo, Scene } from '@babylonjs/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newPrimitive } from '../model/defaults';
import { MeshRegistry } from './meshes';
import { attachPicking } from './picking';

let engine: NullEngine;
let scene: Scene;
let registry: MeshRegistry;

beforeEach(() => {
  engine = new NullEngine();
  scene = new Scene(engine);
  registry = new MeshRegistry(scene);
});
afterEach(() => {
  registry.dispose();
  scene.dispose();
  engine.dispose();
});

const down = (x: number, y: number) =>
  new PointerInfo(PointerEventTypes.POINTERDOWN, { button: 0, clientX: x, clientY: y } as PointerEvent, null);
const up = (x: number, y: number) =>
  new PointerInfo(PointerEventTypes.POINTERUP, { button: 0, clientX: x, clientY: y } as PointerEvent, null);

describe('attachPicking', () => {
  it('selects the object under a click', () => {
    registry.sync([newPrimitive('box', 0, [0, 0, 0], 'Box 1')]);
    const picks: Array<string | null> = [];
    const detach = attachPicking(scene, registry, (id) => picks.push(id));

    scene.onPointerObservable.notifyObservers(down(10, 10));
    scene.onPointerObservable.notifyObservers(up(10, 10));

    expect(picks).toHaveLength(1);
    detach();
  });

  // A press that lands on a gizmo (the utility layer) never reaches this observer; only the
  // release does. Without a `pressed` flag that stray release would be scored against whatever
  // earlier press this observer last saw, and could clear or change the selection by accident.
  it('ignores a release with no matching press on the main scene', () => {
    const picks: Array<string | null> = [];
    const detach = attachPicking(scene, registry, (id) => picks.push(id));

    scene.onPointerObservable.notifyObservers(down(10, 10));
    scene.onPointerObservable.notifyObservers(up(10, 10));
    expect(picks).toHaveLength(1);

    // Simulates a gizmo drag: the press went to the utility layer, so this observer saw no
    // POINTERDOWN for it, only the POINTERUP once the drag ends — close enough to the stale
    // press above to pass the slop check were it not for the `pressed` guard.
    scene.onPointerObservable.notifyObservers(up(11, 11));

    expect(picks).toHaveLength(1);
    detach();
  });
});
