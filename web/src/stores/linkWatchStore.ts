import { create } from 'zustand';
import type { BrokerFailure, ConnectionState } from '../types/api';

/**
 * What the API forgets the moment a link comes back.
 *
 * `failure` is null whenever the client is connected, and rightly so — it describes why there is
 * no link, and there is one. But "it dropped, here is what broke it, and it is back" is a
 * sentence that needs the failure *after* the recovery, so the console keeps its own copy.
 *
 * It also remembers who opened the Broker panel. A panel the reader asked for steps aside when a
 * link comes up, which is the right thing to do with a form they have just finished with. A panel
 * a fault opened is not that: they never asked for it, so closing it "back" would leave them with
 * a link that went away and came back and no idea that either happened.
 */
export type LinkWatchState = {
  /** What took the link down, kept across the recovery. Null when nothing has. */
  failure: BrokerFailure | null;
  /** When the link went, as epoch milliseconds. Null when it has not. */
  droppedAt: number | null;
  /**
   * When it came back, if it has. Null while it is still down.
   *
   * Both stamps are kept because the notice says how long it was gone, and neither one alone can.
   */
  recoveredAt: number | null;
  /** The Broker panel was opened by a drop rather than by the reader. */
  openedByFault: boolean;

  /**
   * Whether a link has actually been up, which is what makes a fault a *drop*.
   *
   * Without it, a Connect the reader pressed and that failed would read as a link going down —
   * and the console would answer a form they are already looking at by opening it again and
   * telling them their link had dropped. Nothing dropped: it never came up.
   */
  wasUp: boolean;

  /**
   * One connection state, and what it means for the three above.
   *
   * The whole transition table lives here rather than in an effect in a component, because two
   * components need the answer and a second copy of it is a second thing that can be wrong.
   */
  saw: (state: ConnectionState, failure: BrokerFailure | null | undefined, now?: number) => void;

  /** The reader has read the notice. Clears the recovery, not the memory of the outage. */
  dismiss: () => void;

  /** The panel was closed by hand, so it is no longer a panel a fault is holding open. */
  released: () => void;
};

export const useLinkWatchStore = create<LinkWatchState>((set, get) => ({
  failure: null,
  droppedAt: null,
  recoveredAt: null,
  openedByFault: false,
  wasUp: false,

  saw: (state, failure, now = Date.now()) => {
    const current = get();

    if (state === 'Faulted') {
      // Already known about, and this test comes first because a ladder puts the link back into
      // Faulted once a rung — with wasUp false, since the link is down. Re-stamping would make
      // the notice say the outage began at the last rung rather than at the drop, and would
      // reopen a panel the reader had just closed.
      if (current.droppedAt !== null) {
        // The reason can still sharpen: the first announcement of a drop carries whatever
        // MQTTnet said, and a later rung's refusal is often the more specific of the two.
        if (failure && !current.failure) set({ failure });
        return;
      }

      // A fault on a link that was never up is a connect that failed, and that is the Broker
      // panel's own business — it has the form that made the attempt and a sentence under it.
      // Nothing here is about it, and a console that answered it by opening the panel the reader
      // is already looking at, to tell them their link had dropped, would be wrong twice.
      if (!current.wasUp) return;

      set({
        failure: failure ?? null,
        droppedAt: now,
        recoveredAt: null,
        openedByFault: true,
        // The link is down, so the next fault after a recovery has to be earned again.
        wasUp: false,
      });

      return;
    }

    if (state === 'Connected') {
      // Whatever else this state means, a link is up — so the next fault is a drop.
      if (!current.wasUp) set({ wasUp: true });

      // Only a link that had actually gone is a recovery. A first connection is not news, and a
      // notice saying so on the first successful connect of a session would be the console
      // congratulating itself.
      if (current.droppedAt === null || current.recoveredAt !== null) return;

      set({ recoveredAt: now });

      return;
    }

    // Connecting is a rung of the ladder or the reader dialling; either way the outage is not
    // over and nothing here changes. Disconnected is somebody hanging up on purpose, which ends
    // the outage without recovering from it — there is nothing to tell them they already know.
    if (state === 'Disconnected') set(rested);
  },

  dismiss: () => set({ ...rested, wasUp: get().wasUp }),

  released: () => set({ openedByFault: false }),
}));

/**
 * Nothing has happened to the link that the reader has not already seen.
 *
 * `wasUp` is deliberately not in here. Hanging up on purpose puts it back to false — there is no
 * link, so nothing can drop — but dismissing a notice about a link that is up must not, or the
 * very next drop would be read as a first connect that failed and told nobody.
 */
const rested = {
  failure: null,
  droppedAt: null,
  recoveredAt: null,
  openedByFault: false,
  wasUp: false,
} as const;

/**
 * Back to "nothing has happened to the link".
 *
 * For tests, and it is not optional there. This store is a module singleton that remembers a
 * whole session's worth of link history, and it is the one store whose contents change what a
 * *panel* renders — a test that connected successfully leaves `wasUp` set, and the next test in
 * the file renders its faulted broker as a dropped link. That is a leak between tests that reads
 * as a bug in the panel.
 */
export const resetLinkWatch = () =>
  useLinkWatchStore.setState({
    failure: null,
    droppedAt: null,
    recoveredAt: null,
    openedByFault: false,
    wasUp: false,
  });
