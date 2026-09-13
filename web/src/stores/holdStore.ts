import { useMemo } from 'react';
import { create } from 'zustand';
import {
  arrivedBehind,
  forgetFrozen,
  freeze,
  LIVE,
  paneState,
  shownRuns,
  type Held,
  type Holds,
  type PaneState,
} from '../lib/holds';
import { mergeRuns, useLogStore, type LogEntry } from './logStore';
import type { TopicRing } from './topicRing';
import { useTopicTreeStore } from './topicTreeStore';

/**
 * Every hold the reader is keeping, by the filter it was taken on — and the view every pane reads
 * through them.
 *
 * They accumulate. A reader watching a plant holds the row they are reading, goes to look at
 * another topic, and wants to come back to the reading they stopped: a hold is over a topic, and
 * the reader looking somewhere else is exactly when it is worth having. What lets one go is the
 * reader — on the row, or from the Manage panel — a Clear or an unsubscribe that empties it, or a
 * fresh tree.
 */
type HoldState = {
  held: Holds;
  /** A hold on a row's filter, frozen from what the console is showing under it now. */
  take: (filter: string) => void;
  /** One hold, by its filter — or every one of them, which is what a fresh tree does. */
  release: (filter?: string) => void;
  /** Topics taken out of every hold: what Clear and an unsubscribe do to what the reader paused. */
  forget: (remove: (topic: string) => boolean, keep: 'nothing' | 'the newest') => void;
};

export const useHoldStore = create<HoldState>((set, get) => ({
  held: new Map(),

  take: (filter) => {
    const { held } = get();
    if (held.has(filter)) return;

    const frozen = freeze(
      filter,
      useLogStore.getState().byTopic,
      useTopicTreeStore.getState().root,
      held,
    );
    if (frozen) set({ held: new Map(held).set(filter, frozen) });
  },

  release: (filter) =>
    set((state) => {
      if (filter === undefined) return state.held.size === 0 ? {} : { held: new Map() };
      if (!state.held.has(filter)) return {};

      const rest = new Map(state.held);
      rest.delete(filter);

      return { held: rest };
    }),

  forget: (remove, keep) =>
    set((state) => {
      let changed = false;
      const rest = new Map<string, Held>();

      for (const [filter, held] of state.held) {
        const left = forgetFrozen(held, remove, keep);
        if (left !== held) changed = true;
        if (left) rest.set(filter, left);
      }

      return changed ? { held: rest } : {};
    }),
}));

// Connecting starts the tree again, and what a hold froze belonged to the tree that has gone. Left
// standing it would go on drawing a session that has ended — and, because a row it covers with
// nothing frozen for it is kept off screen, it would hide the new session's rows under it.
useTopicTreeStore.subscribe((state, previous) => {
  if (state.generation !== previous.generation) useHoldStore.getState().release();
});

/** What a filter shows through the holds: the one answer every reader of it shares. */
export interface Shown {
  /** One run per topic, newest first — what a chart draws. */
  readonly runs: LogEntry[][];
  /** The runs merged newest first — what the log draws. Merged on first read. */
  readonly entries: LogEntry[];
  readonly count: number;
  /**
   * What has arrived behind the holds — behind the filter's own hold, when it has one.
   *
   * Counted against the live log the first time it is read, so it belongs to the render it was
   * read in: a view kept past its version must not be asked for it, since the log it would be
   * counted against has since moved on.
   */
  readonly arrived: number;
  readonly state: PaneState;
}

class View implements Shown {
  readonly runs: LogEntry[][];
  readonly count: number;
  readonly state: PaneState;
  private readonly filter: string;
  private readonly byTopic: ReadonlyMap<string, TopicRing>;
  private readonly holds: Holds;
  private merged: LogEntry[] | null;
  private behindHolds: number | null = null;

  constructor(
    filter: string,
    byTopic: ReadonlyMap<string, TopicRing>,
    holds: Holds,
    runs: LogEntry[][],
    merged: LogEntry[] | null,
  ) {
    this.filter = filter;
    this.byTopic = byTopic;
    this.holds = holds;
    this.runs = runs;
    this.merged = merged;
    this.state = paneState(holds, filter);
    this.count = runs.reduce((total, run) => total + run.length, 0);
  }

  get entries(): LogEntry[] {
    return (this.merged ??= mergeRuns(this.runs));
  }

  get arrived(): number {
    return (this.behindHolds ??= arrivedBehind(
      this.byTopic,
      this.holds,
      this.filter,
      this.state.own ?? undefined,
    ));
  }

  /** The merged run if somebody has read it, so the next view over the same runs need not merge. */
  get mergedSoFar(): LogEntry[] | null {
    return this.merged;
  }
}

const NOTHING: Shown = { runs: [], entries: [], count: 0, arrived: 0, state: LIVE };

/** How many views have been worked out — read by the test that holds this to once per change. */
export const shownWork = { count: 0 };

/** The last view per filter. A handful are read at once: the selection's, and the windows'. */
const views = new Map<string, { version: number; holds: Holds; view: View }>();
const KEPT = 16;

/** The filters whose views are kept, oldest first — read by the tests that hold the cache to what can still be handed back. */
export const keptViews = (): string[] => [...views.keys()];

export function shownFor(filter: string | undefined): Shown {
  if (!filter) return NOTHING;

  const { byTopic, version } = useLogStore.getState();
  const holds = useHoldStore.getState().held;

  const last = views.get(filter);
  if (last && last.version === version && last.holds === holds) return last.view;

  shownWork.count++;

  const fresh = shownRuns(byTopic, holds, filter);
  // Held runs come back as the very arrays the hold keeps, so a pane over a held run is handed the
  // same runs while traffic it is not showing goes past — and a chart does not redraw for it.
  const same = last !== undefined && sameRuns(last.view.runs, fresh);
  const view = new View(
    filter,
    byTopic,
    holds,
    same ? last.view.runs : fresh,
    same ? last.view.mergedSoFar : null,
  );

  // Each view holds a run of the log as it was, and a console that has been cleared or turned its
  // log over would otherwise go on holding it for a filter that may never be read again — so
  // whenever a view is worked out, every other filter's view that can no longer be handed back is
  // let go here. One stays only if it was worked out under this very holds map, and either at the
  // log's current version or drawn wholly from holds: such a view's runs are the holds' own frozen
  // arrays rather than a place in a log that a clear or a turnover moves past, so it stays true for
  // as long as the holds themselves stand.
  for (const [other, kept] of views) {
    if (other === filter) continue;
    const canHandBack = kept.holds === holds && (kept.version === version || kept.view.state.over !== null);
    if (!canHandBack) views.delete(other);
  }

  views.delete(filter);
  views.set(filter, { version, holds, view });
  if (views.size > KEPT) views.delete(views.keys().next().value!);

  return view;
}

const sameRuns = (a: LogEntry[][], b: LogEntry[][]) =>
  a.length === b.length && a.every((run, i) => run === b[i]);

/**
 * The view for a filter, in a component.
 *
 * The log's version and the holds are the two things that can change what any filter shows, and
 * they are held here for that alone: the signal to ask again. The answer is shared — the log, its
 * count, the chart and the controls used to work the same run out seven times per arrival.
 */
export function useShown(filter: string | undefined): Shown {
  const version = useLogStore((state) => state.version);
  const holds = useHoldStore((state) => state.held);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- version and holds are the signal, see above
  return useMemo(() => shownFor(filter), [filter, version, holds]);
}
