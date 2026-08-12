import { create } from 'zustand';
import type { BodyMode } from '../lib/payload';

/** What a click on a topic or a message hands to the publish form. */
export type Draft = {
  topic: string;
  /** Absent for a branch that has never carried a message of its own; the form keeps what it has. */
  payload?: string;
  /** How `payload` is written. Absent leaves the form in whatever mode it is already in. */
  mode?: BodyMode;
  qos: number;
  retain: boolean;
};

// Serial rather than value equality: clicking the same topic twice has to reload the form, and
// two identical drafts are indistinguishable without it.
type LoadedDraft = Draft & { serial: number };

type ComposeState = {
  draft: LoadedDraft | null;
  load: (draft: Draft) => void;
};

let nextSerial = 0;

export const useComposeStore = create<ComposeState>((set) => ({
  draft: null,

  load: (draft) => set({ draft: { ...draft, serial: ++nextSerial } }),
}));
