import { useCallback, useMemo } from 'react';
import { create } from 'zustand';
import { matchesFilter } from '../../lib/topicMatch';
import { snapshotUnder, type TopicNode } from '../../lib/topicTree';
import { useTopicTreeStore } from '../../stores/topicTreeStore';
import { runFor, runsFor, runsOf, useLogStore, type LogEntry } from '../../stores/logStore';
import { useSelectionStore } from '../../stores/selectionStore';

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

type HoldState = {
  held: Held | null;
  hold: (filter: string, entries: LogEntry[], nodes: Map<string, TopicNode>) => void;
  release: () => void;
};

export const useHoldStore = create<HoldState>((set) => ({
  held: null,

  hold: (filter, entries, nodes) => set({ held: { filter, entries, nodes } }),
  release: () => set({ held: null }),
}));

// A hold is over the run in front of the reader, so picking a different topic lets it go: what
// was being kept still is not on screen any more, and a column that came back held would be
// holding a run nobody asked it to.
useSelectionStore.subscribe((state, previous) => {
  if (state.selected?.filter !== previous.selected?.filter) useHoldStore.getState().release();
});

// Connecting starts the tree again, and what a hold froze belonged to the tree that has gone.
// Left standing it would go on drawing a session that has ended — and, because a row it covers
// with nothing frozen behind it is treated as one that arrived behind the hold, it would hide
// the new session's rows under that filter entirely.
useTopicTreeStore.subscribe((state, previous) => {
  if (state.generation !== previous.generation) useHoldStore.getState().release();
});

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
  const held = holding && holding.filter === selected?.filter ? holding.entries : null;

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
export function useHoldControl(): {
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

  const held = holding !== null && holding.filter === selected?.filter;

  const arrived = useMemo(() => {
    if (!held || holding === null || holding.entries.length === 0) return 0;

    // Ids only go up, so what has arrived behind the hold is what is newer than its newest.
    const newest = holding.entries[0].id;

    return runFor(byTopic, holding.filter).filter((entry) => entry.id > newest).length;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `changed` is the signal, see above
  }, [held, holding, byTopic, changed]);

  const toggle = useCallback(() => {
    if (held) return useHoldStore.getState().release();
    if (!selected) return;

    // Read at the click rather than kept in state: both are only needed the moment they are
    // frozen, and keeping them current would put a walk of the log and of the tree on the path
    // of every arrival for the sake of a state that is usually not on.
    useHoldStore
      .getState()
      .hold(
        selected.filter,
        runFor(byTopic, selected.filter),
        snapshotUnder(useTopicTreeStore.getState().root, selected.filter),
      );
  }, [held, selected, byTopic]);

  return { can: selected !== null, held, arrived, toggle };
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

  // The filter is checked as well as the hold: the release above runs on the store rather than
  // in a render, so for one render the hold can still be the old selection's.
  const held = holding && holding.filter === selected?.filter ? holding.entries : null;

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

