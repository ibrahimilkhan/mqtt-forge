import { MeshBuilder, NullEngine, Quaternion, Scene, Vector3 } from '@babylonjs/core';
import { describe, expect, it } from 'vitest';
import { transformFromMesh } from './transform';

describe('transformFromMesh', () => {
  it('reads position, rotation, wrapped angles and scale back off a mesh', () => {
    const scene = new Scene(new NullEngine());
    const mesh = MeshBuilder.CreateBox('b', {}, scene);
    mesh.position = new Vector3(1, 2, 3);
    mesh.rotationQuaternion = Quaternion.FromEulerAngles(0, Math.PI / 2, 0);
    mesh.scaling = new Vector3(2, 2, 2);

    const t = transformFromMesh(mesh);

    expect(t.position).toEqual([1, 2, 3]);
    expect(t.euler[1]).toBeCloseTo(Math.PI / 2);
    expect(t.rotation[3]).toBeCloseTo(Math.cos(Math.PI / 4));
    expect(t.scaling).toEqual([2, 2, 2]);
  });
});
