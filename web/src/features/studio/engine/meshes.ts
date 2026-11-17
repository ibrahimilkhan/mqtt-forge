import { Color3, PBRMaterial, Quaternion, type AbstractMesh, type Mesh, type Scene } from '@babylonjs/core';
import type { StudioObject } from '../model/document';
import { applyMaterial } from './materials';
import { createShape } from './primitives';

/**
 * Amber, not the console's petrol: that is lost on the view's near-black, and the gizmos already
 * spend red, green and blue on their axes.
 */
const OUTLINE_COLOUR = Color3.FromHexString('#ffb020');
const OUTLINE_WIDTH = 0.02;

type Entry = { object: StudioObject; mesh: Mesh; material: PBRMaterial };

/**
 * The meshes, kept in step with the document's objects by id.
 *
 * DesignBox mapped document to mesh in two places — loading and undo — and the two had drifted
 * (undo skipped transparency and the persistent id). There is one mapping now, `place`, and it
 * runs only for an object whose record changed: the store's updates are immutable, so an object
 * nobody touched is the same reference it was, and comparing references is the whole diff.
 */
export class MeshRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly scene: Scene;
  private readonly onCreate: (mesh: Mesh) => void;

  constructor(scene: Scene, onCreate: (mesh: Mesh) => void = () => {}) {
    this.scene = scene;
    this.onCreate = onCreate;
  }

  get size() {
    return this.entries.size;
  }

  sync(objects: readonly StudioObject[]) {
    const seen = new Set<string>();

    for (const object of objects) {
      seen.add(object.id);
      const entry = this.entries.get(object.id);

      if (!entry || entry.object.type !== object.type) {
        if (entry) this.remove(object.id);
        this.create(object);
      } else if (entry.object !== object) {
        place(entry, object);
      }
    }

    for (const id of [...this.entries.keys()]) if (!seen.has(id)) this.remove(id);
  }

  mesh(id: string) {
    return this.entries.get(id)?.mesh;
  }

  /**
   * Outlines the meshes of `ids` and no others. Asked whenever the selection or the objects change
   * rather than every frame: a mesh made again for a new shape starts with no outline of its own.
   * The width is in the mesh's own units, before its scaling — thin enough not to swallow a small
   * part, and the price of using Babylon's outline rather than a highlight layer and its extra pass.
   */
  outline(ids: readonly string[]) {
    const wanted = new Set(ids);
    for (const [id, { mesh }] of this.entries) {
      const on = wanted.has(id);
      if (mesh.renderOutline === on) continue;
      mesh.renderOutline = on;
      if (on) {
        mesh.outlineColor = OUTLINE_COLOUR;
        mesh.outlineWidth = OUTLINE_WIDTH;
      }
    }
  }

  /** The object a picked mesh draws, looking up through parents for a model's sub-meshes. */
  idOf(mesh: AbstractMesh | null): string | undefined {
    for (let node: AbstractMesh | null = mesh; node; node = node.parent as AbstractMesh | null) {
      const id = (node.metadata as { studioId?: string } | null)?.studioId;
      if (id && this.entries.has(id)) return id;
    }
    return undefined;
  }

  dispose() {
    for (const id of [...this.entries.keys()]) this.remove(id);
  }

  private create(object: StudioObject) {
    const mesh = createShape(object.type, this.scene);
    mesh.metadata = { studioId: object.id };
    mesh.rotationQuaternion = new Quaternion();
    const material = new PBRMaterial(`studio-${object.id}`, this.scene);
    mesh.material = material;

    const entry = { object, mesh, material };
    place(entry, object);
    this.entries.set(object.id, entry);
    this.onCreate(mesh);
  }

  private remove(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.mesh.dispose();
    entry.material.dispose();
    this.entries.delete(id);
  }
}

function place(entry: Entry, object: StudioObject) {
  const { mesh, material } = entry;
  mesh.name = object.name;
  mesh.position.set(...object.position);
  mesh.rotationQuaternion!.set(...object.rotation);
  mesh.scaling.set(...object.scaling);
  mesh.setEnabled(!object.hidden);
  mesh.isPickable = !object.frozen;
  applyMaterial(material, object);
  entry.object = object;
}
