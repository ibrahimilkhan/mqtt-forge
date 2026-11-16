import { NullEngine } from '@babylonjs/core';
import { describe, expect, it } from 'vitest';
import { blankScene } from '../model/defaults';
import { createStudioStore } from '../studioStore';
import { hasWebGL, StudioEngine } from './StudioEngine';

const opened = () => {
  const store = createStudioStore();
  store.getState().open(blankScene('Cell'));
  const studio = new StudioEngine(new NullEngine(), store);
  return { store, studio };
};

describe('StudioEngine', () => {
  it('draws what is in the store and follows it', () => {
    const { store, studio } = opened();
    const id = store.getState().addPrimitive('box', [0, 0, 0]);
    expect(studio.registry.mesh(id)).toBeDefined();

    store.getState().removeObjects([id]);
    expect(studio.registry.mesh(id)).toBeUndefined();
    studio.dispose();
  });

  it('draws a scene that was already open when it started', () => {
    const store = createStudioStore();
    store.getState().open(blankScene('Cell'));
    const id = store.getState().addPrimitive('sphere', [0, 0, 0]);

    const studio = new StudioEngine(new NullEngine(), store);
    expect(studio.registry.mesh(id)).toBeDefined();
    studio.dispose();
  });

  it('stops following the store once disposed', () => {
    const { store, studio } = opened();
    studio.dispose();
    expect(() => store.getState().addPrimitive('box', [0, 0, 0])).not.toThrow();
    expect(studio.registry.size).toBe(0);
  });

  it('outlines what is selected, and only that', () => {
    const { store, studio } = opened();
    const a = store.getState().addPrimitive('box', [0, 0, 0]);
    const b = store.getState().addPrimitive('sphere', [2, 0, 0]);

    store.getState().select([a, b]);
    expect(studio.registry.mesh(a)!.renderOutline).toBe(true);
    expect(studio.registry.mesh(b)!.renderOutline).toBe(true);

    store.getState().select([b]);
    expect(studio.registry.mesh(a)!.renderOutline).toBe(false);
    expect(studio.registry.mesh(b)!.renderOutline).toBe(true);

    store.getState().select([]);
    expect(studio.registry.mesh(b)!.renderOutline).toBe(false);
    studio.dispose();
  });

  it('outlines a selected object\'s new mesh when its shape is changed', () => {
    const { store, studio } = opened();
    const id = store.getState().addPrimitive('box', [0, 0, 0]);
    store.getState().select([id]);

    store.getState().updateObject(id, { type: 'sphere' });
    expect(studio.registry.mesh(id)!.renderOutline).toBe(true);
    studio.dispose();
  });

  it('puts new shapes where the camera is looking, on the ground', () => {
    const { studio } = opened();
    expect(studio.viewCentre()).toEqual([0, 0, 0]);
    studio.dispose();
  });

  // jsdom has no WebGL; the panel says so rather than throwing inside Babylon.
  it('knows when there is no WebGL to draw with', () => {
    expect(hasWebGL()).toBe(false);
  });
});
