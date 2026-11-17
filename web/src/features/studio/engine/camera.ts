import { ArcRotateCamera, Vector3, type AbstractMesh, type ArcRotateCameraMouseWheelInput, type Scene } from '@babylonjs/core';

/** Starting pose and the limits `tuneCamera` and `createCamera` keep it within. */
export const CAMERA = {
  alpha: -Math.PI / 4,
  beta: Math.PI / 3.2,
  radius: 14,
  minRadius: 0.5,
  maxRadius: 200,
  /** The lowest the eye may go, so the floor is never seen from underneath. */
  minY: 0.05,
  /** Short of straight up from below, where the view's direction stops being defined. */
  betaMax: Math.PI - 0.05,
  baseAngular: 1000,
  rotateRefRadius: 10,
  near: 0.1,
  far: 300,
} as const;

/**
 * The orbit camera. With a canvas it takes the pointer, zooms towards the cursor rather than the
 * middle of the screen, and leaves the arrow keys to the page rather than turning the view.
 */
export function createCamera(scene: Scene, canvas: HTMLCanvasElement | null): ArcRotateCamera {
  const camera = new ArcRotateCamera('studio-camera', CAMERA.alpha, CAMERA.beta, CAMERA.radius, Vector3.Zero(), scene);
  camera.lowerRadiusLimit = CAMERA.minRadius;
  camera.upperRadiusLimit = CAMERA.maxRadius;
  camera.wheelDeltaPercentage = 0.01;
  camera.minZ = CAMERA.near;
  camera.maxZ = CAMERA.far;

  if (canvas) {
    camera.attachControl(canvas, true);
    camera.inputs.removeByType('ArcRotateCameraKeyboardMoveInput');
    const wheel = camera.inputs.attached.mousewheel as ArcRotateCameraMouseWheelInput | undefined;
    if (wheel) wheel.zoomToMouseLocation = true;
  }

  return camera;
}

/**
 * Called before every frame. Speeds follow distance — fixed ones were far too fast up close — and
 * the camera is kept above the floor. Allocates nothing, since it runs sixty times a second.
 */
export function tuneCamera(camera: ArcRotateCamera, heightPx: number) {
  if (camera.target.y < 0) camera.target.y = 0;

  // Eye height is target.y + r·cos(β) ≥ minY, so β ≤ acos((minY − target.y) / r).
  const c = (CAMERA.minY - camera.target.y) / Math.max(1e-6, camera.radius);
  camera.upperBetaLimit = c >= 1 ? 0.02 : Math.min(CAMERA.betaMax, Math.acos(Math.max(-1, c)));
  if (camera.beta > camera.upperBetaLimit) camera.beta = camera.upperBetaLimit;

  // The point under the cursor moves with the cursor: one pixel of drag, one pixel of world at the
  // target's depth. Babylon multiplies every input by 1/(1−inertia), so that is taken back out.
  const worldPerPixel = (2 * camera.radius * Math.tan(camera.fov / 2)) / Math.max(1, heightPx);
  camera.panningSensibility = 1 / (worldPerPixel * (1 - camera.panningInertia));

  const slow = Math.min(3, Math.max(1, Math.sqrt(CAMERA.rotateRefRadius / camera.radius)));
  camera.angularSensibilityX = camera.angularSensibilityY = CAMERA.baseAngular * slow;
  camera.minZ = Math.min(CAMERA.near, Math.max(0.01, camera.radius * 0.02));
}

/** Looks at the mesh from far enough away to see all of it. */
export function focusOn(camera: ArcRotateCamera, mesh: AbstractMesh) {
  const { min, max } = mesh.getHierarchyBoundingVectors(true);
  camera.setTarget(min.add(max).scaleInPlace(0.5));
  camera.radius = Math.max(CAMERA.minRadius * 2, max.subtract(min).length() * 1.5);
}
