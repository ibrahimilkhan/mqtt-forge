import { Quaternion, type AbstractMesh } from '@babylonjs/core';
import { wrapEuler, type Vec3 } from '../geometry/euler';
import type { StudioObject } from '../model/document';

/** What a gizmo did to a mesh, as the document's fields — the way back from Babylon to the store. */
export function transformFromMesh(mesh: AbstractMesh): Pick<StudioObject, 'position' | 'rotation' | 'euler' | 'scaling'> {
  const q = mesh.rotationQuaternion ?? Quaternion.FromEulerVector(mesh.rotation);
  const e = q.toEulerAngles();

  return {
    position: mesh.position.asArray() as Vec3,
    rotation: [q.x, q.y, q.z, q.w],
    euler: wrapEuler([e.x, e.y, e.z]),
    scaling: mesh.scaling.asArray() as Vec3,
  };
}
