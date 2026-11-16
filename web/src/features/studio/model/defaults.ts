import type { Vec3 } from '../geometry/euler';
import { newId } from './ids';
import { SCENE_VERSION, type ObjectType, type PrimitiveType, type SceneSettings, type StudioObject, type StudioScene } from './document';

export const PRIMITIVE_TYPES: readonly PrimitiveType[] = ['box', 'sphere', 'cylinder', 'cone', 'pyramid', 'torus', 'capsule', 'wall'];

export const PRIMITIVE_LABELS: Record<PrimitiveType, string> = {
  box: 'Box',
  sphere: 'Sphere',
  cylinder: 'Cylinder',
  cone: 'Cone',
  pyramid: 'Pyramid',
  torus: 'Torus',
  capsule: 'Capsule',
  wall: 'Wall',
};

/** Handed out in turn, so a row of new shapes can be told apart before anyone colours them. */
export const PRIMITIVE_COLOURS = ['#4f9cff', '#ff6b6b', '#ffd43b', '#69db7c', '#b197fc', '#ff922b', '#3bc9db', '#f783ac'];
const WALL_COLOUR = '#d9d4cc';

/**
 * How far above its origin each shape's base sits at scale 1, so a new one lands on the ground
 * rather than half in it. Matches the sizes `engine/primitives.ts` builds.
 */
const REST_HEIGHT: Record<ObjectType, number> = {
  box: 0.5, sphere: 0.5, cylinder: 0.5, cone: 0.5, pyramid: 0.5, torus: 0.15, capsule: 0.6, wall: 0.75, model: 0.25,
};
export const restHeight = (type: ObjectType) => REST_HEIGHT[type];

export const MATERIAL_PRESETS = {
  plastic: { label: 'Plastic', metal: 0, rough: 0.5 },
  matte: { label: 'Matte', metal: 0, rough: 0.9 },
  glossy: { label: 'Gloss paint', metal: 0, rough: 0.15 },
  steel: { label: 'Steel', metal: 1, rough: 0.35 },
  brushed: { label: 'Brushed metal', metal: 1, rough: 0.55 },
  chrome: { label: 'Chrome', metal: 1, rough: 0.05 },
} as const;
export type MaterialPreset = keyof typeof MATERIAL_PRESETS;
export const DEFAULT_MATERIAL = { metal: 0, rough: 0.5 };

export const DEFAULT_SETTINGS: SceneSettings = { displayUnit: 'mm', moveStep: 0.01, rotateStep: 15, snap: true };

export function blankScene(name: string): StudioScene {
  return {
    version: SCENE_VERSION,
    id: newId(),
    name,
    updatedAt: new Date().toISOString(),
    settings: { ...DEFAULT_SETTINGS },
    objects: [],
    groups: [],
    poses: [],
    annotations: [],
  };
}

/** A new shape standing on the ground at `at`; `index` picks its colour from the palette. */
export function newPrimitive(type: PrimitiveType, index: number, at: Vec3, name: string): StudioObject {
  return {
    id: newId(),
    type,
    name,
    position: [at[0], at[1] + restHeight(type), at[2]],
    rotation: [0, 0, 0, 1],
    euler: [0, 0, 0],
    scaling: [1, 1, 1],
    color: type === 'wall' ? WALL_COLOUR : PRIMITIVE_COLOURS[index % PRIMITIVE_COLOURS.length],
  };
}
