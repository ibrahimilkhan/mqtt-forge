export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

const TAU = 2 * Math.PI;

/**
 * Into (-π, π]. A gimbal ring turned round and round used to leave 464° in the panel — the same
 * pose, but a nonsense number, and typing a new angle then went the long way round.
 */
export const wrapAngle = (a: number) => {
  const wrapped = a - TAU * Math.round(a / TAU);
  return wrapped <= -Math.PI + 1e-9 ? wrapped + TAU : wrapped;
};

export const wrapEuler = ([x, y, z]: Vec3): Vec3 => [wrapAngle(x), wrapAngle(y), wrapAngle(z)];

/** The angles that reach `to`'s pose from `from` the shortest way on each axis. */
export const nearestEuler = (from: Vec3, to: Vec3): Vec3 => [
  from[0] + wrapAngle(to[0] - from[0]),
  from[1] + wrapAngle(to[1] - from[1]),
  from[2] + wrapAngle(to[2] - from[2]),
];

/**
 * Babylon's `Quaternion.FromEulerAngles(x, y, z)` — yaw y, pitch x, roll z — written out so the
 * store can turn an angle typed into the inspector into a rotation without importing Babylon.
 */
export function quatFromEuler([x, y, z]: Vec3): Quat {
  const [sr, cr] = [Math.sin(z / 2), Math.cos(z / 2)];
  const [sp, cp] = [Math.sin(x / 2), Math.cos(x / 2)];
  const [sy, cy] = [Math.sin(y / 2), Math.cos(y / 2)];

  return [
    cy * sp * cr + sy * cp * sr,
    sy * cp * cr - cy * sp * sr,
    cy * cp * sr - sy * sp * cr,
    cy * cp * cr + sy * sp * sr,
  ];
}
