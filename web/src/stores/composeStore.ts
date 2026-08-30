import { create } from 'zustand';
import type { BodyMode } from '../lib/payload';

/**
 * What a click on a topic or a message hands to the publish form.
 *
 * Where to send and what to send — and nothing about how.
 *
 * It used to carry a QoS and a retain flag too, taken off whatever was clicked: a tree node
 * handed over its newest arrival's flags, a log row handed over the delivered copy's. Both are
 * facts about a message that has already been, and neither is a thing the reader asked for. So
 * ticking QoS 2 and Retain and then clicking the tree to aim the form put the ticks back to
 * QoS 0 and not retained, silently, before Publish was pressed — and the message went out at
 * QoS 0 exactly as the log then said it had.
 *
 * That is the half of 'publishing ignores QoS and retain' this console was actually getting
 * wrong. The other half was the two ceilings the console set on itself — it listened at QoS 0 and
 * did not ask for retain as published — so the copy it got back could not carry either of the
 * publisher's answers. Both are lifted now, which is what makes the flags below worth carrying:
 * a message's QoS and retain flag on a row are the ones it was *sent* with.
 *
 * So a draft may carry them again, and they are optional for the reason payload and mode are: a
 * branch that has never held a message of its own has no answer, only the placeholders, and a
 * placeholder written into the form is the ticked QoS 2 going quietly back to nought.
 *
 * How a message goes out is the reader's setting and lives below, where nothing can load over it.
 */
export type Draft = {
  topic: string;
  /** Absent for a branch that has never carried a message of its own; the form keeps what it has. */
  payload?: string;
  /** How `payload` is written. Absent leaves the form in whatever mode it is already in. */
  mode?: BodyMode;
  /**
   * How a real message was sent, where the draft is one. Absent on anything that is a place
   * rather than a message, and absent leaves the reader's own answer standing.
   */
  qos?: number;
  retain?: boolean;
};

// Serial rather than value equality: clicking the same topic twice has to reload the form, and
// two identical drafts are indistinguishable without it.
type LoadedDraft = Draft & { serial: number };

type ComposeState = {
  draft: LoadedDraft | null;
  load: (draft: Draft) => void;
  /**
   * How the next message goes out, which is the reader's answer and outlives the form.
   *
   * Here rather than in the panel because the panel is unmounted whenever the region is folded —
   * 'unmounted rather than hidden' is the workspace's own rule — and state in an unmounted
   * component is a setting that quietly goes back to nought while the reader is looking at
   * something else.
   */
  qos: number;
  retain: boolean;
  setQos: (qos: number) => void;
  setRetain: (retain: boolean) => void;
};

let nextSerial = 0;

export const useComposeStore = create<ComposeState>((set) => ({
  draft: null,

  load: (draft) => set({ draft: { ...draft, serial: ++nextSerial } }),

  qos: 0,
  retain: false,
  setQos: (qos) => set({ qos }),
  setRetain: (retain) => set({ retain }),
}));
