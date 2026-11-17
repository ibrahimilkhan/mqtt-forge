import type { Quat, Vec3 } from '../geometry/euler';
import type { DisplayUnit } from '../units/units';

/**
 * The scene as it is saved — DesignBox's sahne.json made explicit and versioned.
 *
 * Version 1 is what DesignBox wrote (and never checked on reading). Version 2 is this: object ids
 * instead of list positions for links, model files referenced by key instead of carried inline as
 * base64, and settings that used to live in the browser's own storage.
 *
 * Joints, groups, poses and annotations are typed loosely on purpose. Phase 1 neither draws nor
 * edits them; it only has to carry them through a save untouched, and Phase 3 narrows the types
 * when it starts using them.
 */
export const SCENE_VERSION = 2;

export type PrimitiveType = 'box' | 'sphere' | 'cylinder' | 'cone' | 'pyramid' | 'torus' | 'capsule' | 'wall';
export type ObjectType = PrimitiveType | 'model';

export type Material = { metal: number; rough: number };
export type MaterialOverride = Material & { color: string };
export type ModelRef = { key: string; ext: string; importScale?: number };

export type Joint = { type: 'rev' | 'lin'; name: string } & Record<string, unknown>;
export type Group = { id: string; name: string } & Record<string, unknown>;
export type Pose = { id: string; name: string; angles: Record<string, number> };
export type Annotation = { id: string; type: string } & Record<string, unknown>;

export type SceneSettings = {
  displayUnit: DisplayUnit;
  /** Metres. */
  moveStep: number;
  /** Degrees. */
  rotateStep: number;
  snap: boolean;
};

export type StudioObject = {
  id: string;
  type: ObjectType;
  name: string;
  position: Vec3;
  rotation: Quat;
  /** Radians, kept beside the quaternion so the inspector shows the angles the reader typed. */
  euler: Vec3;
  scaling: Vec3;
  color?: string;
  mat?: Material;
  matOverride?: MaterialOverride;
  model?: ModelRef;
  parentId?: string;
  groupId?: string;
  groupUnlocked?: boolean;
  hidden?: boolean;
  frozen?: boolean;
  transparent?: boolean;
  rotPivot?: Vec3;
  joint?: Joint;
  /** Fields a DesignBox file carried that this version does not act on yet, kept for a later phase. */
  legacy?: Record<string, unknown>;
};

export type StudioScene = {
  version: typeof SCENE_VERSION;
  id: string;
  name: string;
  updatedAt: string;
  settings: SceneSettings;
  objects: StudioObject[];
  groups: Group[];
  poses: Pose[];
  annotations: Annotation[];
};
