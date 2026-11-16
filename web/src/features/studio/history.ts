import type { StudioScene } from './model/document';

/** Steps kept. Snapshots share every object a change did not touch, so a step costs what it changed. */
export const HISTORY_LIMIT = 100;

export type History = { past: StudioScene[]; future: StudioScene[] };

/** Remembers `before` as the scene to go back to; a new step ends any redo trail. */
export const record = (history: History, before: StudioScene): History => ({
  past: [...history.past, before].slice(-HISTORY_LIMIT),
  future: [],
});

export function undo(history: History, current: StudioScene): { history: History; scene: StudioScene } | null {
  const scene = history.past.at(-1);
  if (!scene) return null;
  return { scene, history: { past: history.past.slice(0, -1), future: [current, ...history.future] } };
}

export function redo(history: History, current: StudioScene): { history: History; scene: StudioScene } | null {
  const [scene, ...future] = history.future;
  if (!scene) return null;
  return { scene, history: { past: [...history.past, current].slice(-HISTORY_LIMIT), future } };
}
