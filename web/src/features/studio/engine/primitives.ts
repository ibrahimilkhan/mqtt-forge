import { MeshBuilder, type Mesh, type Scene } from '@babylonjs/core';
import type { ObjectType } from '../model/document';

/**
 * The shapes, each one metre across at scale 1 — the sizes `restHeight` in model/defaults.ts
 * assumes. A model is a half-metre box until Phase 2 can draw the file it names.
 */
const SHAPES: Record<ObjectType, (scene: Scene) => Mesh> = {
  box: (s) => MeshBuilder.CreateBox('', { size: 1 }, s),
  sphere: (s) => MeshBuilder.CreateSphere('', { diameter: 1, segments: 32 }, s),
  cylinder: (s) => MeshBuilder.CreateCylinder('', { height: 1, diameter: 1, tessellation: 48 }, s),
  cone: (s) => MeshBuilder.CreateCylinder('', { height: 1, diameterTop: 0, diameterBottom: 1, tessellation: 48 }, s),
  pyramid: (s) => MeshBuilder.CreateCylinder('', { height: 1, diameterTop: 0, diameterBottom: 1.2, tessellation: 4 }, s),
  torus: (s) => MeshBuilder.CreateTorus('', { diameter: 1, thickness: 0.3, tessellation: 48 }, s),
  capsule: (s) => MeshBuilder.CreateCapsule('', { height: 1.2, radius: 0.3 }, s),
  wall: (s) => MeshBuilder.CreateBox('', { width: 2, height: 1.5, depth: 0.15 }, s),
  model: (s) => MeshBuilder.CreateBox('', { size: 0.5 }, s),
};

export const createShape = (type: ObjectType, scene: Scene): Mesh => (SHAPES[type] ?? SHAPES.box)(scene);
