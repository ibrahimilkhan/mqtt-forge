import { NullEngine, PBRMaterial, Scene } from '@babylonjs/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newPrimitive } from '../model/defaults';
import type { StudioObject } from '../model/document';
import { MeshRegistry } from './meshes';

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

const box = (patch: Partial<StudioObject> = {}): StudioObject => ({ ...newPrimitive('box', 0, [0, 0, 0], 'Box 1'), ...patch });

describe('MeshRegistry', () => {
  it('makes one mesh per object, placed and coloured as the document says', () => {
    const object = box({ position: [1, 2, 3], scaling: [2, 1, 1], color: '#ff0000' });
    registry.sync([object]);

    const mesh = registry.mesh(object.id)!;
    expect(mesh.position.asArray()).toEqual([1, 2, 3]);
    expect(mesh.scaling.asArray()).toEqual([2, 1, 1]);
    expect((mesh.material as PBRMaterial).albedoColor.toGammaSpace().toHexString()).toBe('#FF0000');
    expect(registry.idOf(mesh)).toBe(object.id);
  });

  it('updates a mesh in place when its object changes, and only then', () => {
    const object = box();
    registry.sync([object]);
    const mesh = registry.mesh(object.id)!;

    registry.sync([{ ...object, position: [5, 0, 0] }]);

    expect(registry.mesh(object.id)).toBe(mesh);
    expect(mesh.position.x).toBe(5);
  });

  it('disposes the mesh and its material when the object goes', () => {
    const object = box();
    registry.sync([object]);
    const mesh = registry.mesh(object.id)!;
    const material = mesh.material!;

    registry.sync([]);

    expect(mesh.isDisposed()).toBe(true);
    expect(scene.materials).not.toContain(material);
    expect(registry.size).toBe(0);
  });

  it('hides a hidden object and makes a frozen one unpickable', () => {
    const object = box({ hidden: true, frozen: true });
    registry.sync([object]);
    const mesh = registry.mesh(object.id)!;
    expect(mesh.isEnabled()).toBe(false);
    expect(mesh.isPickable).toBe(false);
  });

  // Phase 1 cannot load model files yet; the object must still be there to select and move.
  it('draws a model as a translucent placeholder', () => {
    const model: StudioObject = { ...box(), type: 'model', model: { key: 'k.glb', ext: '.glb' } };
    registry.sync([model]);
    expect(registry.mesh(model.id)!.material!.alpha).toBeLessThan(1);
  });

  it('dispose leaves nothing of its own in the scene', () => {
    registry.sync([box(), box({ id: 'b2' })]);
    registry.dispose();
    expect(scene.meshes).toHaveLength(0);
    expect(scene.materials).toHaveLength(0);
  });
});
