import { create } from 'zustand';
import type { FlowNoticeDto } from '../types/api';

/** How many notices stand at once. A fifth pushes the oldest out: a stack taller than this is a wall nobody reads. */
export const NOTICES_SHOWN = 4;

/** How long a notice stands before it goes by itself. */
export const NOTICE_MS = 8_000;

/** A notice as the console keeps it: the server's, and an id to close it by. */
export type Notice = FlowNoticeDto & { id: number };

type NoticeState = {
  /** Newest first. */
  notices: Notice[];
  add: (notices: FlowNoticeDto[]) => void;
  dismiss: (id: number) => void;
};

/**
 * The last id given out; the next notice gets one more than this. Never reset, so no two notices
 * in one console share one: it is the key a card is drawn under, and what the card's timer and its
 * Close dismiss it by.
 */
let made = 0;

/**
 * What Notify nodes have said, for the stack in the corner of the console.
 *
 * In the main chunk and not the Flows page's, because a notice is for whoever has the console open,
 * on whatever page: a flow watching the plant says something while its reader is looking at the tree.
 */
export const useNoticeStore = create<NoticeState>()((set) => ({
  notices: [],

  add: (notices) =>
    set((state) => ({
      notices: [...notices.map((notice) => ({ ...notice, id: ++made })).reverse(), ...state.notices].slice(0, NOTICES_SHOWN),
    })),

  dismiss: (id) => set((state) => ({ notices: state.notices.filter((notice) => notice.id !== id) })),
}));
