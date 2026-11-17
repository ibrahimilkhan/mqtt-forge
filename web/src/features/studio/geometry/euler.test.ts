import { Quaternion } from '@babylonjs/core';
import { describe, expect, it } from 'vitest';
import { nearestEuler, quatFromEuler, wrapAngle, wrapEuler } from './euler';

describe('angles', () => {
  it('wraps into (-π, π]', () => {
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI);
    expect(wrapAngle(-Math.PI)).toBeCloseTo(Math.PI);
    expect(wrapAngle((464 * Math.PI) / 180)).toBeCloseTo((104 * Math.PI) / 180);
    expect(wrapEuler([4 * Math.PI, 0, -3 * Math.PI])).toEqual([expect.closeTo(0), 0, expect.closeTo(Math.PI)]);
  });

  it('reaches the same pose by the shortest way on every axis', () => {
    const [x] = nearestEuler([(170 * Math.PI) / 180, 0, 0], [(-170 * Math.PI) / 180, 0, 0]);
    expect(x).toBeCloseTo((190 * Math.PI) / 180);
  });

  // Written by hand so the store stays free of Babylon; held to Babylon's own answer so a pose
  // typed into the inspector is the pose the gizmo then shows.
  it('builds the same quaternion Babylon does', () => {
    const e: [number, number, number] = [0.3, -1.1, 2.4];
    const ours = quatFromEuler(e);
    const theirs = Quaternion.FromEulerAngles(...e);
    expect(ours[0]).toBeCloseTo(theirs.x, 10);
    expect(ours[1]).toBeCloseTo(theirs.y, 10);
    expect(ours[2]).toBeCloseTo(theirs.z, 10);
    expect(ours[3]).toBeCloseTo(theirs.w, 10);
  });
});
