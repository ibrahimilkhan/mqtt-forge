import { Color3, Color4, CubeTexture, DirectionalLight, HemisphericLight, MeshBuilder, ShadowGenerator, Vector3, type ArcRotateCamera, type Scene } from '@babylonjs/core';
import { GridMaterial, ShadowOnlyMaterial } from '@babylonjs/materials';

const GROUND_SIZE = 200;
const SHADOW_MAP_SIZE = 2048;
/** How far back along the light the sun stands from what it lights. */
const SUN_DISTANCE = 150;
/** Fine grid spacings, metres; the finest that stays ten pixels apart on screen is drawn. */
const GRID_STEPS = [0.001, 0.01, 0.1, 1, 10];
const GRID_MIN_PX = 10;

/**
 * Lights, the ground grid, a shadow-only layer just above it, and reflections from an environment
 * map. The shadow area follows the camera's target rather than covering the whole floor, so shadows
 * stay sharp up close; its centre snaps to the shadow map's texel so they do not shimmer in a pan.
 */
export function setupRendering(scene: Scene, camera: ArcRotateCamera, options: { environmentUrl?: string; shadows: boolean; onLoaded?: () => void }) {
  scene.clearColor = new Color4(0.08, 0.09, 0.11, 1);

  const hemi = new HemisphericLight('studio-hemi', new Vector3(0, 1, 0), scene);
  hemi.intensity = 0.55;
  hemi.groundColor = new Color3(0.2, 0.2, 0.25);

  const sun = new DirectionalLight('studio-sun', new Vector3(-1, -2, -1.2), scene);
  sun.intensity = 0.9;
  sun.autoUpdateExtends = false;
  sun.autoCalcShadowZBounds = false;
  sun.shadowMinZ = 1;
  sun.shadowMaxZ = 300;

  const ground = MeshBuilder.CreateGround('studio-ground', { width: GROUND_SIZE, height: GROUND_SIZE }, scene);
  ground.isPickable = false;
  const grid = new GridMaterial('studio-grid', scene);
  grid.gridRatio = 1;
  grid.majorUnitFrequency = 10;
  grid.minorUnitVisibility = 0.35;
  grid.mainColor = new Color3(0.22, 0.23, 0.27);
  grid.lineColor = new Color3(0.45, 0.48, 0.56);
  ground.material = grid;

  let shadows: ShadowGenerator | null = null;
  const catcher = MeshBuilder.CreateGround('studio-shadows', { width: GROUND_SIZE, height: GROUND_SIZE }, scene);
  catcher.position.y = 0.01;
  catcher.isPickable = false;
  catcher.receiveShadows = true;
  const shadowMaterial = new ShadowOnlyMaterial('studio-shadow-material', scene);
  shadowMaterial.activeLight = sun;
  shadowMaterial.alpha = 0.45;
  catcher.material = shadowMaterial;

  if (options.shadows) {
    shadows = new ShadowGenerator(SHADOW_MAP_SIZE, sun);
    shadows.usePercentageCloserFiltering = true;
    shadows.bias = 0.0005;
    shadows.normalBias = 0.01;
  }

  // Worked out once: the plane square to the light the shadow area is laid out in.
  const sunDir = sun.direction.clone().normalize();
  const right = Vector3.Cross(Vector3.Up(), sunDir).normalize();
  const up = Vector3.Cross(sunDir, right).normalize();
  const centre = new Vector3();
  const scratch = new Vector3();
  // Compared with === against the previous frame's values instead of building a key string, so
  // the common case (camera unchanged) allocates nothing: this runs every frame.
  let lastHalf = Number.NaN;
  let lastCr = Number.NaN;
  let lastCu = Number.NaN;
  let gridShown = 0;

  const frame = scene.onBeforeRenderObservable.add(() => {
    const perPx = (2 * camera.radius * Math.tan(camera.fov / 2)) / Math.max(1, scene.getEngine().getRenderHeight());
    let step = GRID_STEPS[GRID_STEPS.length - 1];
    for (const g of GRID_STEPS) {
      if (g / perPx >= GRID_MIN_PX) {
        step = g;
        break;
      }
    }
    if (step !== gridShown) grid.gridRatio = gridShown = step;

    const half = Math.min(GROUND_SIZE / 2, Math.max(4, camera.radius * 1.4));
    const texel = (2 * half) / SHADOW_MAP_SIZE;
    const t = camera.target;
    const cr = Math.round(Vector3.Dot(t, right) / texel) * texel;
    const cu = Math.round(Vector3.Dot(t, up) / texel) * texel;
    if (half === lastHalf && cr === lastCr && cu === lastCu) return;
    lastHalf = half;
    lastCr = cr;
    lastCu = cu;

    centre.copyFrom(right).scaleInPlace(cr);
    centre.addInPlace(scratch.copyFrom(up).scaleInPlace(cu));
    centre.addInPlace(scratch.copyFrom(sunDir).scaleInPlace(Vector3.Dot(t, sunDir)));
    sun.position.copyFrom(centre).subtractInPlace(scratch.copyFrom(sunDir).scaleInPlace(SUN_DISTANCE));
    sun.orthoLeft = sun.orthoBottom = -half;
    sun.orthoRight = sun.orthoTop = half;
  });

  // The texture loads asynchronously; dispose() may already have run by the time either callback
  // fires, and touching the scene then would log a spurious warning or write to a dead object.
  let disposed = false;

  let environment: CubeTexture | null = null;
  if (options.environmentUrl) {
    environment = new CubeTexture(
      options.environmentUrl,
      scene,
      null,
      false,
      null,
      () => {
        if (disposed) return;
        scene.environmentTexture = environment;
        scene.environmentIntensity = 0.75;
        options.onLoaded?.();
      },
      // Without reflections metal turns dark; the fill light makes up some of the difference.
      () => {
        if (disposed) return;
        console.warn('The studio lighting file could not be loaded; drawing without reflections.');
        hemi.intensity = 0.8;
        options.onLoaded?.();
      },
      undefined,
      true,
    );
  }

  return {
    shadows,
    dispose: () => {
      disposed = true;
      scene.onBeforeRenderObservable.remove(frame);
      environment?.dispose();
    },
  };
}
