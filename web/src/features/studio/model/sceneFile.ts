import { quatFromEuler, type Quat, type Vec3 } from '../geometry/euler';
import { dataUrlToBlob } from './dataUrl';
import { DEFAULT_SETTINGS } from './defaults';
import { SCENE_VERSION, type Annotation, type Group, type Joint, type ObjectType, type Pose, type StudioObject, type StudioScene } from './document';

/** Why a file could not be read as a scene, in a sentence the reader is shown. */
export class SceneFileError extends Error {}

/** An inline DesignBox model waiting to be uploaded before its scene is saved. */
export type PendingModel = { objectId: string; dataUrl: string; ext: string };

type Raw = Record<string, unknown>;
const isObject = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const vec3 = (value: unknown, fallback: Vec3): Vec3 =>
  Array.isArray(value) && value.length === 3 && value.every(Number.isFinite) ? (value as Vec3) : fallback;
const quat = (value: unknown, fallback: Quat): Quat =>
  Array.isArray(value) && value.length === 4 && value.every(Number.isFinite) ? (value as Quat) : fallback;

/** The fields a version 1 object carries that this reader turns into something else, or drops. */
const CONSUMED = new Set([
  'type', 'name', 'pid', 'position', 'rotation', 'euler', 'scaling', 'color', 'mat', 'matOverride', 'model', 'modelKey',
  'ext', 'importScale', 'link', 'groupId', 'groupUnlocked', 'hidden', 'frozen', 'transparent', 'rotPivot', 'joint', 'uid',
]);

/**
 * A scene file as the studio can use it: version 2 as it is, version 1 (DesignBox's sahne.json, or
 * an export with no version at all) migrated, and anything newer refused rather than half read.
 *
 * `fallback` is the id and name a version 1 file is given: DesignBox scenes had neither inside the
 * file. Inline models come back in `pending`, to be uploaded by `uploadPending` before the scene is
 * saved — the scene keeps an empty key for them until then.
 */
export function readSceneFile(raw: unknown, fallback: { id: string; name: string }): { scene: StudioScene; pending: PendingModel[] } {
  if (!isObject(raw)) throw new SceneFileError('This file is not a scene: it holds no JSON object.');

  const version = raw.version ?? 1;
  if (version === SCENE_VERSION) return { scene: raw as StudioScene, pending: [] };
  if (typeof version !== 'number' || version > SCENE_VERSION)
    throw new SceneFileError('This scene was written by a newer version of the studio and cannot be opened here.');
  if (!Array.isArray(raw.objects)) throw new SceneFileError('This file is not a scene: it has no list of objects.');

  return fromVersion1(raw, raw.objects, fallback);
}

function fromVersion1(raw: Raw, items: unknown[], fallback: { id: string; name: string }) {
  const sources = items.filter(isObject);
  // Ids first, so a link can be resolved whichever way round the two objects are listed.
  const ids = sources.map((item, i) => (typeof item.pid === 'string' && item.pid ? item.pid : `obj-${i + 1}`));
  const pending: PendingModel[] = [];
  let unnamedJoints = 0;

  const objects = sources.map((item, i): StudioObject => {
    const euler = vec3(item.euler, [0, 0, 0]);
    const object: StudioObject = {
      id: ids[i],
      type: (typeof item.type === 'string' ? item.type : 'box') as ObjectType,
      name: typeof item.name === 'string' ? item.name : `Object ${i + 1}`,
      position: vec3(item.position, [0, 0, 0]),
      rotation: quat(item.rotation, quatFromEuler(euler)),
      euler,
      scaling: vec3(item.scaling, [1, 1, 1]),
    };

    if (typeof item.color === 'string') object.color = item.color;
    if (isObject(item.mat)) object.mat = item.mat as StudioObject['mat'];
    if (isObject(item.matOverride)) object.matOverride = item.matOverride as StudioObject['matOverride'];
    if (typeof item.groupId === 'string') object.groupId = item.groupId;
    if (item.groupUnlocked === true) object.groupUnlocked = true;
    if (item.hidden === true) object.hidden = true;
    if (item.frozen === true) object.frozen = true;
    if (item.transparent === true) object.transparent = true;
    if (Array.isArray(item.rotPivot)) object.rotPivot = vec3(item.rotPivot, [0, 0, 0]);

    // DesignBox linked by position in the list; a link to itself or past the end is no link.
    if (typeof item.link === 'number' && item.link !== i && ids[item.link] !== undefined) object.parentId = ids[item.link];

    if (isObject(item.joint)) {
      const joint = { ...item.joint } as Joint;
      if (joint.type !== 'lin') joint.type = 'rev';
      if (typeof joint.name !== 'string' || !joint.name.trim()) joint.name = `Joint ${++unnamedJoints}`;
      object.joint = joint;
    }

    if (object.type === 'model') {
      const ext = typeof item.ext === 'string' ? item.ext.toLowerCase() : '';
      object.model = { key: '', ext, ...(typeof item.importScale === 'number' ? { importScale: item.importScale } : {}) };
      if (typeof item.model === 'string' && item.model.startsWith('data:')) pending.push({ objectId: object.id, dataUrl: item.model, ext });
    }

    const legacy = Object.fromEntries(Object.entries(item).filter(([key]) => !CONSUMED.has(key)));
    if (Object.keys(legacy).length > 0) object.legacy = legacy;

    return object;
  });

  const scene: StudioScene = {
    version: SCENE_VERSION,
    id: fallback.id,
    name: fallback.name,
    updatedAt: new Date().toISOString(),
    settings: { ...DEFAULT_SETTINGS },
    objects,
    groups: (Array.isArray(raw.groups) ? raw.groups.filter(isObject) : []) as Group[],
    poses: (Array.isArray(raw.poses) ? raw.poses.filter(isObject) : []) as Pose[],
    annotations: (Array.isArray(raw.annotations) ? raw.annotations.filter(isObject) : []) as Annotation[],
  };

  return { scene, pending };
}

/** Uploads each pending model and answers the scene with their keys in place; the input is not changed. */
export async function uploadPending(
  scene: StudioScene,
  pending: PendingModel[],
  upload: (blob: Blob, ext: string) => Promise<{ key: string }>,
): Promise<StudioScene> {
  const keys = new Map<string, string>();
  for (const model of pending) {
    const { key } = await upload(dataUrlToBlob(model.dataUrl).blob, model.ext);
    keys.set(model.objectId, key);
  }

  return {
    ...scene,
    objects: scene.objects.map((object) =>
      object.model && keys.has(object.id) ? { ...object, model: { ...object.model, key: keys.get(object.id)! } } : object,
    ),
  };
}
