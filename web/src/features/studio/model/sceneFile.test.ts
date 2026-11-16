import { describe, expect, it, vi } from 'vitest';
import designbox from './fixtures/designbox-v1.json';
import { blankScene } from './defaults';
import { readSceneFile, SceneFileError, uploadPending } from './sceneFile';

const fallback = { id: 'new1', name: 'Imported' };

describe('reading a DesignBox scene', () => {
  const { scene, pending } = readSceneFile(designbox, fallback);

  it('becomes a version 2 scene under the id and name it is given', () => {
    expect(scene.version).toBe(2);
    expect(scene.id).toBe('new1');
    expect(scene.name).toBe('Imported');
    expect(scene.objects).toHaveLength(3);
  });

  it('keeps each object\'s persistent id, so poses and annotations still point at it', () => {
    expect(scene.objects.map((o) => o.id)).toEqual(['p-base', 'p-arm', 'p-model']);
    expect(scene.poses[0].angles).toEqual({ 'p-arm': 45 });
    expect(scene.annotations[0]).toMatchObject({ A: 'p-base', B: 'p-arm' });
  });

  // DesignBox linked by position in the list, which any reorder silently rewired.
  it('turns a link by index into a parent by id', () => {
    expect(scene.objects[1].parentId).toBe('p-base');
  });

  it('names an unnamed joint and makes a typeless one revolute', () => {
    expect(scene.objects[1].joint).toMatchObject({ type: 'rev', name: 'Joint 1', min: -90, max: 90 });
  });

  it('keeps transform, colour, material and group', () => {
    expect(scene.objects[0]).toMatchObject({ position: [0, 0.5, 0], scaling: [2, 1, 2], color: '#4f9cff', mat: { metal: 1, rough: 0.35 } });
    expect(scene.objects[1].groupId).toBe('g1');
    expect(scene.groups[0]).toMatchObject({ id: 'g1', name: 'Arm group' });
  });

  it('takes the inline model out to be uploaded, keeping what Phase 2 needs to draw it', () => {
    expect(pending).toEqual([{ objectId: 'p-model', dataUrl: expect.stringMatching(/^data:model\/stl;base64,/), ext: '.stl' }]);
    expect(scene.objects[2].model).toEqual({ key: '', ext: '.stl', importScale: 0.001 });
    expect(scene.objects[2].legacy).toEqual({ pivot: 'center' });
  });

  it('reads a file with no version as version 1', () => {
    const { scene: unversioned } = readSceneFile({ ...designbox, version: undefined }, fallback);
    expect(unversioned.objects).toHaveLength(3);
  });
});

describe('reading a version 2 scene', () => {
  it('answers it as it is, with nothing to upload', () => {
    const saved = blankScene('Cell');
    const { scene, pending } = readSceneFile(JSON.parse(JSON.stringify(saved)), fallback);
    expect(scene).toEqual(saved);
    expect(pending).toEqual([]);
  });
});

describe('a version 2 file in the wrong shape', () => {
  it('is refused rather than opened half read', () => {
    const saved = JSON.parse(JSON.stringify(blankScene('Cell')));
    expect(() => readSceneFile({ ...saved, objects: {} }, fallback)).toThrow(SceneFileError);
    expect(() => readSceneFile({ ...saved, settings: [] }, fallback)).toThrow(SceneFileError);
    expect(() => readSceneFile({ ...saved, settings: undefined }, fallback)).toThrow(SceneFileError);
    expect(() => readSceneFile({ ...saved, id: 5 }, fallback)).toThrow(SceneFileError);
    expect(() => readSceneFile({ ...saved, name: null }, fallback)).toThrow(SceneFileError);
  });
});

describe('a file that is not a scene', () => {
  it('says what is wrong with it', () => {
    expect(() => readSceneFile('hello', fallback)).toThrow(SceneFileError);
    expect(() => readSceneFile({ version: 3, objects: [] }, fallback)).toThrow(/newer/);
    expect(() => readSceneFile({ version: 1 }, fallback)).toThrow(/objects/);
  });
});

describe('uploadPending', () => {
  it('uploads each inline model and writes its key into the object', async () => {
    const { scene, pending } = readSceneFile(designbox, fallback);
    const upload = vi.fn().mockResolvedValue({ key: 'a'.repeat(64) + '.stl' });

    const done = await uploadPending(scene, pending, upload);

    expect(upload).toHaveBeenCalledWith(expect.any(Blob), '.stl');
    expect(done.objects[2].model?.key).toBe('a'.repeat(64) + '.stl');
    expect(scene.objects[2].model?.key).toBe('');
  });
});

describe('importing a v1 model with no inline data', () => {
  it('leaves model undefined and records the ext in legacy.missingModel', () => {
    const v1 = {
      version: 1,
      objects: [
        { type: 'model', pid: 'm1', ext: '.stl', importScale: 0.001 },
      ],
    };

    const { scene, pending } = readSceneFile(v1, fallback);

    expect(pending).toEqual([]);
    expect(scene.objects[0].model).toBeUndefined();
    expect(scene.objects[0].legacy?.missingModel).toEqual({ ext: '.stl', importScale: 0.001 });
  });
});

describe('importing a v1 object with an unknown type', () => {
  it('becomes a box and keeps the original type in legacy', () => {
    const v1 = {
      version: 1,
      objects: [
        { type: 'gear', pid: 'obj1', name: 'A gear' },
      ],
    };

    const { scene } = readSceneFile(v1, fallback);

    expect(scene.objects[0].type).toBe('box');
    expect(scene.objects[0].legacy?.type).toBe('gear');
  });
});
