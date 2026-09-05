import { create } from 'zustand';

/**
 * What has happened to the link, in order, for as long as the console has been open.
 *
 * The log's command lines say most of this already — Connected, Subscribed, Subscribe failed —
 * and are the wrong place to read it from: the log starts again with every connection, because
 * it is the record of one broker's traffic, so the line saying the last link dropped is gone by
 * the time the next one is up. This is the other record: every connection, every drop, every
 * try the ladder made, kept side by side, so that 'what has this broker been doing all
 * afternoon' has one answer. It is fed from the log (see logStore.push) and from the link watch
 * (see useLinkWatch), and it is never cleared by a connection — only by the cap.
 */
export type BrokerEventKind = 'ok' | 'fault' | 'note';

export type BrokerEvent = {
  id: number;
  at: Date;
  kind: BrokerEventKind;
  /** One line, in the voice of the log's verbs: 'Link dropped', 'Try 3 failed', 'Subscribed'. */
  what: string;
  /** The sentence under it, if there is one — the reason, the filter, the endpoint. */
  detail?: string;
  /**
   * What this line is about, when a later line of the same kind supersedes it rather than
   * following it.
   *
   * The ladder's tries are the case it exists for. A broker down overnight makes a line a rung —
   * about 1080 of them by morning — and the record was then 200 identical 'Try N failed' lines
   * with the drop that started them long gone off the end. What a reader wants is one line
   * saying how many tries there have been, standing above the drop it belongs to.
   */
  key?: string;
};

/** Enough for an afternoon of a flapping broker; a day of one is not worth scrolling. */
export const MAX_EVENTS = 200;

type EventsState = {
  /** Newest first, as the log is. */
  events: BrokerEvent[];
  push: (event: Omit<BrokerEvent, 'id' | 'at'>) => void;
  clear: () => void;
};

let nextId = 0;

export const useBrokerEventsStore = create<EventsState>((set) => ({
  events: [],

  push: (event) =>
    set((state) => {
      const written = { ...event, id: nextId++, at: new Date() };

      // A keyed line replaces the one it supersedes, and only while that one is still the newest:
      // once anything else has happened the old line is part of the story and stays where it is.
      const rest =
        event.key !== undefined && state.events[0]?.key === event.key
          ? state.events.slice(1)
          : state.events;

      return { events: [written, ...rest].slice(0, MAX_EVENTS) };
    }),

  clear: () => set({ events: [] }),
}));
