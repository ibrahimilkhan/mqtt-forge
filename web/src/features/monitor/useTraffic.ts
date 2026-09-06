import { useCallback, useMemo } from 'react';
import { create } from 'zustand';
import { matchesFilter } from '../../lib/topicMatch';
import { filterPath, snapshotUnder, type TopicNode } from '../../lib/topicTree';
import { useTopicTreeStore } from '../../stores/topicTreeStore';
import { runFor, runsFor, runsOf, useLogStore, type LogEntry } from '../../stores/logStore';
import { useSelectionStore } from '../../stores/selectionStore';
import { useSearchStore } from '../../stores/searchStore';
import { found } from '../../lib/sift';

/**
 * The run of traffic the right column is reading, and the hold over it.
 *
 * The entries, the chart and the count all answer for the same run, and they sit in three
 * separate regions of the column now — so the run itself cannot live inside any one of them.
 * It lives here, derived from the log and the selection, with the hold beside it.
 */

/**
 * A run held still, and the rows of the tree it was read from.
 *
 * Both, because the control sits on one of those rows. A hold that stopped the entries and the
 * chart but let the row's own counts go on climbing would be a pause the reader can watch not
 * working, on the very row they pressed it.
 */
type Held = { filter: string; entries: LogEntry[]; nodes: Map<string, TopicNode> };

/**
 * Every hold the reader is keeping, by the filter it was taken on.
 *
 * One at a time was the first shape and it was the wrong one. A reader watching a plant holds
 * the row they are reading, goes to look at another topic, and wants to come back to the reading
 * they stopped — which the old shape could not do at all: picking another topic let the hold go,
 * on the grounds that a hold is 'over the run in front of the reader'. It is not. It is over a
 * topic, and the reader looking somewhere else is exactly when it is worth having.
 *
 * So they accumulate, and the pane draws whichever one covers what is selected. What lets them
 * go is the reader — on the row, or from the Manage panel, which is where a reader who has
 * paused six topics finds out that they did.
 */
type HoldState = {
  held: ReadonlyMap<string, Held>;
  hold: (filter: string, entries: LogEntry[], nodes: Map<string, TopicNode>) => void;
  /** One hold, by its filter — or every one of them, which is what a fresh tree does. */
  release: (filter?: string) => void;
};

export const useHoldStore = create<HoldState>((set) => ({
  held: new Map(),

  hold: (filter, entries, nodes) =>
    set((state) => ({ held: new Map(state.held).set(filter, { filter, entries, nodes }) })),

  release: (filter) =>
    set((state) => {
      if (filter === undefined) return state.held.size === 0 ? {} : { held: new Map() };
      if (!state.held.has(filter)) return {};

      const rest = new Map(state.held);
      rest.delete(filter);

      return { held: rest };
    }),
}));

// Connecting starts the tree again, and what a hold froze belonged to the tree that has gone.
// Left standing it would go on drawing a session that has ended — and, because a row it covers
// with nothing frozen behind it is treated as one that arrived behind the hold, it would hide
// the new session's rows under that filter entirely.
useTopicTreeStore.subscribe((state, previous) => {
  if (state.generation !== previous.generation) useHoldStore.getState().release();
});

/**
 * The hold on one filter, or nothing.
 *
 * A function rather than a lookup at each call site because what a reader means by 'this run is
 * paused' is not only the hold taken on this exact filter: a pane showing `plant/boiler/temp`
 * under a hold taken on `plant/boiler/#` is showing a held run, and it has to read as one.
 * Exact first, since that is the common case and costs nothing.
 */
export function holdOver(held: ReadonlyMap<string, Held>, filter: string | undefined): Held | null {
  if (!filter || held.size === 0) return null;

  const exact = held.get(filter);
  if (exact) return exact;

  for (const one of held.values()) {
    if (coversFilter(one.filter, filter)) return one;
  }

  return null;
}

/**
 * Whether a hold taken on one filter covers a selection of another.
 *
 * A path under a held branch is covered; the branch under a held leaf is not. `filterPath`
 * peels the '/#' off a tree row's filter, which is every filter a hold can be taken on here;
 * anything else falls back to the matcher.
 */
function coversFilter(hold: string, filter: string): boolean {
  if (hold === filter) return true;

  const branch = filterPath(hold);
  const under = filterPath(filter) ?? filter;
  if (branch === null) return matchesFilter(hold, under);

  return under === branch || under.startsWith(`${branch}/`);
}

/**
 * The newest command that failed on this selection, and is still failing.
 *
 * Every fault the console records — a subscribe the broker refused, a publish it rejected — is
 * written to the same log the arrivals go into, and nothing has ever drawn one: this store has
 * exactly one display reader, and it admits arrivals only. So a reader whose subscribe was
 * refused saw the same sentence a genuinely quiet topic gives, and 'the broker is silent', 'my
 * subscription failed' and 'the publish never left' were indistinguishable.
 *
 * Only while it is still true. A 'Subscribe failed' from ten minutes ago, since retried and
 * granted, would otherwise go on explaining a silence it is no longer the cause of — so a later
 * success naming the same filter clears it.
 */
export function faultOn(commands: LogEntry[], filter: string): LogEntry | null {
  for (const entry of commands) {
    if (!entry.topic || !overlaps(filter, entry.topic)) continue;

    // The log is newest first, so the first of either kind found is the one that stands.
    if (entry.kind === 'ok') return null;
    if (entry.kind === 'fault') return entry;
  }

  return null;
}

/**
 * Whether a command aimed at one filter has anything to say about a selection of another.
 *
 * Both sides are filters rather than topics — a command is aimed at `sensors/#` and the reader is
 * looking at `sensors/room/temp/#` — so neither direction of the ordinary match is enough on its
 * own, and both are tried. A command whose topic is not a filter at all, like the '3 filters' a
 * batch subscribe records, matches nothing and is passed over.
 */
const overlaps = (filter: string, aimedAt: string) =>
  matchesFilter(filter, aimedAt) || matchesFilter(aimedAt, filter);

export type Traffic = {
  selected: ReturnType<typeof useSelectionStore.getState>['selected'];
  /** What the log holds on the selection right now, whatever the column is showing. */
  live: LogEntry[];
  /** What the column is showing, one run per topic — the shape a chart draws from. */
  runs: LogEntry[][];
  /** What the column is showing: the live run, or the one the hold froze. */
  entries: LogEntry[];
  held: boolean;
  /** How much has arrived behind the hold — nothing to say while the column is live. */
  arrived: number;
  /** The newest command that failed on this selection and has not since succeeded. */
  fault: LogEntry | null;
  /** Every entry on show is the same topic, so naming it on each of them says nothing new. */
  single: boolean;
};

/**
 * The run on one filter, whatever the console has selected.
 *
 * The pane below reads the selection; a pinned window reads the filter it was pinned on and goes
 * on reading it while the selection moves elsewhere. Both are the same question of the log, so
 * both ask it the same way.
 */
export function useRunFor(filter: string | undefined): LogEntry[] {
  const byTopic = useLogStore((state) => state.byTopic);
  // The runs are mutated in place, so the map is the same object from one arrival to the next
  // and cannot say on its own that anything changed. `version` is what says it, and is held
  // here for that alone: the signal to ask again, not something read.
  const changed = useLogStore((state) => state.version);

  return useMemo(
    () => (filter ? runFor(byTopic, filter) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `changed` is the signal, see above
    [byTopic, changed, filter],
  );
}

/**
 * The same run, left as one sequence per topic — what a chart of a branch actually draws.
 *
 * Beside `useRunFor` rather than replacing it: the log reads one topic after another in the
 * order they arrived and wants them merged, the chart draws a plot per topic and wants them
 * apart. Merging for the chart and splitting again on the other side was the most expensive
 * thing this console did.
 */
export function useRunsFor(filter: string | undefined): LogEntry[][] {
  const byTopic = useLogStore((state) => state.byTopic);
  const changed = useLogStore((state) => state.version);

  return useMemo(
    () => (filter ? runsFor(byTopic, filter) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `changed` is the signal, see above
    [byTopic, changed, filter],
  );
}

/**
 * How many entries the selection holds, and nothing else.
 *
 * The same reasoning as `useHoldControl` below: a number beside a region's name is a badge, and a
 * badge must not put the log's whole run on the path of every arrival. `runsFor` hands the runs
 * back as they are kept, so this is a sum of their lengths — where `useRunFor` above merges them
 * into one sequence and sorts it, which is the work the pane needs and a count does not.
 */
export function useTrafficCount(): number {
  const selected = useSelectionStore((state) => state.selected);
  const byTopic = useLogStore((state) => state.byTopic);
  const changed = useLogStore((state) => state.version);
  const holding = useHoldStore((state) => state.held);

  // Held, the count answers for what is on screen rather than for what has arrived behind it —
  // the same rule the pane keeps, and the reason a hold reads as a hold.
  const held = holdOver(holding, selected?.filter)?.entries ?? null;

  return useMemo(
    () => {
      if (held) return held.length;
      if (!selected) return 0;

      return runsFor(byTopic, selected.filter).reduce((total, run) => total + run.length, 0);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `changed` is the signal, see above
    [held, selected, byTopic, changed],
  );
}

/**
 * The pause, for a control that is not in the pane it pauses.
 *
 * It reads what it needs and nothing more. The run itself is only gathered while the pane is
 * actually held — which is a deliberate, temporary state — so a control sitting in the rail
 * does not put a walk of the log on the path of every arrival for the sake of a badge that is
 * usually not there. Taking the hold reads the run once, at the click.
 */
export function useHoldControl(over?: string): {
  can: boolean;
  held: boolean;
  arrived: number;
  toggle: () => void;
} {
  const selected = useSelectionStore((state) => state.selected);
  const holding = useHoldStore((state) => state.held);
  const byTopic = useLogStore((state) => state.byTopic);
  // A number, so this costs a comparison per arrival rather than a run.
  const changed = useLogStore((state) => state.version);

  // The filter this control is about: the one it was given, or whatever is selected. A control
  // on a row that is not the selected one is how a reader lets go of a topic they paused and
  // then went to look at something else — which is the whole reason holds accumulate.
  const filter = over ?? selected?.filter;
  const mine = filter === undefined ? null : (holding.get(filter) ?? null);
  const held = mine !== null;

  const arrived = useMemo(() => {
    if (mine === null || mine.entries.length === 0) return 0;

    // Ids only go up, so what has arrived behind the hold is what is newer than its newest.
    const newest = mine.entries[0].id;

    return runFor(byTopic, mine.filter).filter((entry) => entry.id > newest).length;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `changed` is the signal, see above
  }, [mine, byTopic, changed]);

  const toggle = useCallback(() => {
    if (filter === undefined) return;
    if (held) return useHoldStore.getState().release(filter);

    // Read at the click rather than kept in state: both are only needed the moment they are
    // frozen, and keeping them current would put a walk of the log and of the tree on the path
    // of every arrival for the sake of a state that is usually not on.
    useHoldStore
      .getState()
      .hold(
        filter,
        runFor(byTopic, filter),
        snapshotUnder(useTopicTreeStore.getState().root, filter),
      );
  }, [held, filter, byTopic]);

  return { can: filter !== undefined, held, arrived, toggle };
}

export function useTraffic(): Traffic {
  // Only the commands: this is read to explain a silence, and what explains one is what this
  // console tried and was refused, never the traffic itself.
  const commands = useLogStore((state) => state.commands);
  const selected = useSelectionStore((state) => state.selected);
  const holding = useHoldStore((state) => state.held);

  const live = useRunFor(selected?.filter);
  const liveRuns = useRunsFor(selected?.filter);

  // Only worth looking for while the selection has nothing to show; that is the one moment a
  // reader is asking why, and a scan of the log on every arrival is not worth paying otherwise.
  const fault = useMemo(
    () => (selected && live.length === 0 ? faultOn(commands, selected.filter) : null),
    [commands, selected, live.length],
  );

  // Whichever hold covers what is selected — the one taken on this very filter, or the one on a
  // branch above it.
  const held = holdOver(holding, selected?.filter)?.entries ?? null;

  // Held, the chart goes on drawing what it was drawing. The hold keeps one sequence because
  // the log beside it reads that way; grouping it back into runs costs one pass, paid when the
  // hold is taken rather than on every arrival — nothing arrives into a run that is held.
  const runs = useMemo(() => (held ? runsOf(held) : liveRuns), [held, liveRuns]);

  return {
    selected,
    live,
    runs,
    // Held, the column keeps drawing the run it was drawing; the log behind it carries on
    // filling. Reading a value while the row it is in is being replaced is the oldest complaint
    // about consoles, and stopping the log to fix it throws away the traffic you were there for.
    entries: held ?? live,
    held: held !== null,
    // Ids only go up, so what has arrived since is what is newer than the newest one held.
    arrived: held?.length ? live.filter((entry) => entry.id > held[0].id).length : 0,
    fault,
    // Read off the run rather than off the filter: a tree leaf selects `path/#`, which is a
    // wildcard that happens to match one topic, and a wildcard that happens to match one topic
    // is exactly the case worth catching.
    single: (held ?? live).every((entry) => entry.topic === (held ?? live)[0]?.topic),
  };
}

/**
 * The rows the log pane draws: the run the selection holds, narrowed by what the reader is
 * looking for.
 *
 * Only the rows. The chart under the pane goes on drawing the whole run, and it should: a search
 * is a reader finding a line, not a reader changing what the console is watching, and a shape
 * that redrew itself every time somebody typed a letter into a box would be answering a question
 * nobody asked of it.
 */
export function useShownEntries(): { entries: LogEntry[]; all: number; sought: boolean } {
  const { entries } = useTraffic();
  const { look, where } = useSearchStore((state) => state.log);

  const shown = useMemo(
    () =>
      look === ''
        ? entries
        : entries.filter((entry) => found({ topic: entry.topic, body: entry.body }, look, where)),
    [entries, look, where],
  );

  return { entries: shown, all: entries.length, sought: look !== '' };
}
