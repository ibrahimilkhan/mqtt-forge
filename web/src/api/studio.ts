import type { StudioScene } from '../features/studio/model/document';
import { ApiError } from '../lib/problemDetails';
import { json, request } from './client';

export type StudioSceneSummary = { id: string; name: string; updatedAt: string };

/** A model is the CAD file itself and can run to a hundred megabytes; the usual fifteen seconds is not enough. */
const UPLOAD_PATIENCE = { timeoutMs: 300_000 };

const scenePath = (id: string) => `/api/studio/scenes/${encodeURIComponent(id)}`;

export const listScenes = () => request<StudioSceneSummary[]>('/api/studio/scenes');

/** The scene as stored: unknown until `readSceneFile` has looked at it. */
export const getScene = (id: string) => request<unknown>(scenePath(id));

/** One scene per request, so two consoles on two scenes never write over each other. */
export const putScene = (scene: StudioScene) => request<void>(scenePath(scene.id), { method: 'PUT', ...json(scene) });

export const deleteScene = (id: string) => request<void>(scenePath(id), { method: 'DELETE' });

/** The bytes as the body, not a form: the server hashes the stream straight to disk. */
export const uploadModel = async (blob: Blob, ext: string) =>
  // Read into a buffer rather than handing over the Blob itself: jsdom's Blob is not one Node's
  // fetch can send, and a buffer is the same bytes everywhere. Never as text — that rewrites every
  // byte that is not UTF-8 in a GLB or STEP file.
  request<{ key: string }>(
    `/api/studio/models?ext=${encodeURIComponent(ext)}`,
    { method: 'POST', body: await blob.arrayBuffer(), headers: { 'Content-Type': 'application/octet-stream' } },
    UPLOAD_PATIENCE,
  );

/** Another console deleted the scene since this one listed it. */
export const isSceneUnknown = (error: unknown): error is ApiError =>
  error instanceof ApiError && error.status === 404 && error.reason === 'sceneUnknown';
