import type { StudioScene } from './model/document';

/** Steps kept. Snapshots share every object a change did not touch, so a step costs what it changed. */
export const HISTORY_LIMIT = 100;

/** A record of past and future scene snapshots so the user can step back and forth through them. */
export type History = { past: StudioScene[]; future: StudioScene[] };

/** Remembers `before` as the scene to go back to; a new step ends any redo trail. */
export const record = (history: History, before: StudioScene): History => ({
  past: [...history.past, before].slice(-HISTORY_LIMIT),
  future: [],
});

/** Restores the last step before the current scene and moves the current scene to the redo trail. */
export function undo(history: History, current: StudioScene): { history: History; scene: StudioScene } | null {
  const scene = history.past.at(-1);
  if (!scene) return null;
  return { scene, history: { past: history.past.slice(0, -1), future: [current, ...history.future] } };
}

/** Restores a step from the redo trail and moves the current scene to the undo trail. */
export function redo(history: History, current: StudioScene): { history: History; scene: StudioScene } | null {
  const [scene, ...future] = history.future;
  if (!scene) return null;
  return { scene, history: { past: [...history.past, current].slice(-HISTORY_LIMIT), future } };
}
