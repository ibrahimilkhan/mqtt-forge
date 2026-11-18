import { Engine, Scene, type AbstractEngine, type ArcRotateCamera } from '@babylonjs/core';
import type { StoreApi } from 'zustand';
import type { Vec3 } from '../geometry/euler';
import type { StudioState } from '../studioStore';
import { createCamera, focusOn, tuneCamera } from './camera';
import { GizmoBridge } from './gizmos';
import { MeshRegistry } from './meshes';
import { attachPicking } from './picking';
import { createRenderGate } from './renderGate';
import { setupRendering } from './rendering';

/** Thrown when the browser cannot give the studio a WebGL context, so the panel can say so. */
export class WebGLUnavailable extends Error {
  constructor(cause?: unknown) {
    super('This browser cannot draw 3D: WebGL is turned off or not available.', { cause });
  }
}

/** Asked before Babylon is, which would otherwise try for a context and throw from deep inside. */
export const hasWebGL = () => typeof WebGLRenderingContext !== 'undefined';

type Options = { canvas?: HTMLCanvasElement; environmentUrl?: string; onStatus?: (status: 'ready' | 'lost') => void };

/**
 * The studio's 3D side: one Babylon engine, scene and camera, drawing whatever the store holds.
 *
 * It owns nothing the store does not. Meshes are made, moved and disposed by following the store;
 * the pointer and the gizmos change the store through its actions and never a mesh directly — so
 * undo, saving and the inspector all see one truth. Everything it creates goes in `dispose`, which
 * the panel calls on close: DesignBox ran once per page and had no way to be taken down.
 *
 * Without a canvas (tests, under Babylon's NullEngine) it draws the scene graph and nothing that
 * needs a pointer or a GPU: no controls, picking, gizmos, shadows or environment.
 */
export class StudioEngine {
  readonly scene: Scene;
  readonly registry: MeshRegistry;
  private readonly engine: AbstractEngine;
  private readonly store: StoreApi<StudioState>;
  private readonly camera: ArcRotateCamera;
  private readonly teardown: Array<() => void> = [];
  /** Asks for the next frames to be drawn. Nothing to ask without a canvas, where nothing loops. */
  private wake = () => {};

  static open(canvas: HTMLCanvasElement, store: StoreApi<StudioState>, onStatus?: Options['onStatus']) {
    if (!hasWebGL()) throw new WebGLUnavailable();

    let engine: Engine;
    try {
      // The last argument draws at the screen's own pixel density, so edges stay sharp.
      engine = new Engine(canvas, true, { stencil: true }, true);
    } catch (error) {
      throw new WebGLUnavailable(error);
    }

    try {
      return new StudioEngine(engine, store, { canvas, environmentUrl: '/studio/environment.env', onStatus });
    } catch (error) {
      // The constructor failed partway through, after the engine was already made; nothing else
      // owns it yet, so it must be disposed here or the WebGL context leaks.
      engine.dispose();
      throw error;
    }
  }

  constructor(engine: AbstractEngine, store: StoreApi<StudioState>, options: Options = {}) {
    this.engine = engine;
    this.store = store;
    const { canvas } = options;
    this.scene = new Scene(engine);
    this.camera = createCamera(this.scene, canvas ?? null);

    const rendering = setupRendering(this.scene, this.camera, {
      environmentUrl: options.environmentUrl,
      shadows: !!canvas,
      // Read when the file arrives rather than now: the gate is made further down.
      onLoaded: () => this.wake(),
    });
    this.teardown.push(rendering.dispose);

    this.registry = new MeshRegistry(this.scene, (mesh) => rendering.shadows?.addShadowCaster(mesh));
    this.teardown.push(() => this.registry.dispose());

    const tune = this.scene.onBeforeRenderObservable.add(() => tuneCamera(this.camera, engine.getRenderHeight()));
    this.teardown.push(() => this.scene.onBeforeRenderObservable.remove(tune));

    const gizmos = canvas ? new GizmoBridge(this.scene, this.registry, store) : null;
    if (gizmos) this.teardown.push(() => gizmos.dispose());

    if (canvas) {
      this.teardown.push(attachPicking(this.scene, this.registry, (id) => store.getState().select(id ? [id] : [])));

      // Drawn when something has changed, not every frame; see renderGate. What can change the
      // picture: the pointer (the camera, the gizmos' hover and drags), the camera still gliding
      // on its inertia, the store, the canvas's size, and the lighting file arriving.
      const gate = createRenderGate();
      this.wake = gate.wake;

      const pointer = ['pointerdown', 'pointermove', 'pointerup', 'pointerleave', 'wheel'] as const;
      for (const type of pointer) canvas.addEventListener(type, this.wake, { passive: true });
      this.teardown.push(() => {
        for (const type of pointer) canvas.removeEventListener(type, this.wake);
      });

      const moved = this.camera.onViewMatrixChangedObservable.add(this.wake);
      this.teardown.push(() => this.camera.onViewMatrixChangedObservable.remove(moved));

      const resize = new ResizeObserver(() => {
        engine.resize();
        this.wake();
      });
      resize.observe(canvas);
      this.teardown.push(() => resize.disconnect());

      const lost = engine.onContextLostObservable.add(() => options.onStatus?.('lost'));
      const restored = engine.onContextRestoredObservable.add(() => {
        options.onStatus?.('ready');
        this.wake();
      });
      this.teardown.push(() => {
        engine.onContextLostObservable.remove(lost);
        engine.onContextRestoredObservable.remove(restored);
      });

      engine.runRenderLoop(() => {
        if (gate.due(!this.scene.isReady())) this.scene.render();
      });
      this.teardown.push(() => engine.stopRenderLoop());
    }

    const follow = (state: StudioState, previous?: StudioState) => {
      const objectsChanged = state.scene?.objects !== previous?.scene?.objects;
      if (objectsChanged) this.registry.sync(state.scene?.objects ?? []);
      if (objectsChanged || state.selection !== previous?.selection) this.registry.outline(state.selection);
      gizmos?.update(state);
      this.wake();
    };
    follow(store.getState());
    this.teardown.push(store.subscribe(follow));

    options.onStatus?.('ready');
  }

  /** Where the camera is looking, put down on the ground: where a new shape lands. */
  viewCentre(): Vec3 {
    const { x, z } = this.camera.target;
    return [x, 0, z];
  }

  focusSelection() {
    const [id] = this.store.getState().selection;
    const mesh = id ? this.registry.mesh(id) : undefined;
    if (!mesh) return;
    focusOn(this.camera, mesh);
    this.wake();
  }

  dispose() {
    // A drag the panel closed on never gets its pointer-up: end it here, or the store keeps a
    // gesture open that nothing will close, and refuses every undo after it.
    this.store.getState().endGesture();
    // Last made, first undone: the store subscription goes before the meshes it would sync.
    for (const undo of this.teardown.reverse()) undo();
    this.teardown.length = 0;
    this.scene.dispose();
    this.engine.dispose();
  }
}
