import { MeshBuilder, NullEngine, Scene, Vector3 } from '@babylonjs/core';
import { describe, expect, it } from 'vitest';
import { CAMERA, createCamera, focusOn, tuneCamera } from './camera';

describe('camera', () => {
  it('never lets the camera go below the floor or the target under it', () => {
    const scene = new Scene(new NullEngine());
    const camera = createCamera(scene, null);
    camera.target = new Vector3(0, -2, 0);
    camera.beta = Math.PI - 0.01;

    tuneCamera(camera, 600);

    expect(camera.target.y).toBe(0);
    expect(camera.position.y).toBeGreaterThanOrEqual(CAMERA.minY - 1e-6);
  });

  it('pans one screen pixel per pixel at the target depth', () => {
    const scene = new Scene(new NullEngine());
    const camera = createCamera(scene, null);
    camera.radius = 10;
    tuneCamera(camera, 500);
    const worldPerPixel = (2 * 10 * Math.tan(camera.fov / 2)) / 500;
    expect(camera.panningSensibility).toBeCloseTo(1 / (worldPerPixel * (1 - camera.panningInertia)));
  });

  it('frames a mesh when focusing on it', () => {
    const scene = new Scene(new NullEngine());
    const camera = createCamera(scene, null);
    const box = MeshBuilder.CreateBox('b', { size: 2 }, scene);
    box.position.set(5, 1, 5);

    focusOn(camera, box);

    expect(camera.target.asArray()).toEqual([5, 1, 5]);
    expect(camera.radius).toBeGreaterThan(2);
  });
});
