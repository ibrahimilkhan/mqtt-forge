import { Color3, type PBRMaterial } from '@babylonjs/core';
import { DEFAULT_MATERIAL } from '../model/defaults';
import type { StudioObject } from '../model/document';

export const PLACEHOLDER_COLOUR = '#8a8f98';
/** How see-through a transparent object, or a model's placeholder, is drawn. */
const SEE_THROUGH = 0.35;

/** Colour, metal and roughness from the document onto the object's own material. */
export function applyMaterial(material: PBRMaterial, object: StudioObject) {
  const placeholder = object.type === 'model';
  const spec = object.mat ?? DEFAULT_MATERIAL;

  material.albedoColor = Color3.FromHexString(placeholder ? PLACEHOLDER_COLOUR : (object.color ?? PLACEHOLDER_COLOUR)).toLinearSpace();
  material.metallic = placeholder ? 0 : spec.metal;
  material.roughness = placeholder ? 0.8 : spec.rough;
  material.alpha = placeholder || object.transparent ? SEE_THROUGH : 1;
}
