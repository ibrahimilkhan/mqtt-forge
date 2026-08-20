import { useMemo } from 'react';
import { create } from 'zustand';
import { matchesFilter } from '../../lib/topicMatch';
import { useLogStore, type LogEntry } from '../../stores/logStore';
import { useSelectionStore } from '../../stores/selectionStore';

/**
 * The run of traffic the right column is reading, and the hold over it.
 *
 * The entries, the chart and the count all answer for the same run, and they sit in three
 * separate regions of the column now — so the run itself cannot live inside any one of them.
 * It lives here, derived from the log and the selection, with the hold beside it.
 */

type Held = { filter: string; entries: LogEntry[] };

type HoldState = {
  held: Held | null;
  hold: (filter: string, entries: LogEntry[]) => void;
  release: () => void;
};

export const useHoldStore = create<HoldState>((set) => ({
  held: null,

  hold: (filter, entries) => set({ held: { filter, entries } }),
  release: () => set({ held: null }),
}));

// A hold is over the run in front of the reader, so picking a different topic lets it go: what
// was being kept still is not on screen any more, and a column that came back held would be
// holding a run nobody asked it to.
useSelectionStore.subscribe((state, previous) => {
  if (state.selected?.filter !== previous.selected?.filter) useHoldStore.getState().release();
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
export function faultOn(log: LogEntry[], filter: string): LogEntry | null {
  for (const entry of log) {
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
  const log = useLogStore((state) => state.entries);

  return useMemo(
    () => (filter ? log.filter((entry) => carriesTraffic(entry, filter)) : []),
    [log, filter],
  );
}

export function useTraffic(): Traffic {
  const log = useLogStore((state) => state.entries);
  const selected = useSelectionStore((state) => state.selected);
  const holding = useHoldStore((state) => state.held);

  const live = useRunFor(selected?.filter);

  // Only worth looking for while the selection has nothing to show; that is the one moment a
  // reader is asking why, and a scan of the log on every arrival is not worth paying otherwise.
  const fault = useMemo(
    () => (selected && live.length === 0 ? faultOn(log, selected.filter) : null),
    [log, selected, live.length],
  );

  // The filter is checked as well as the hold: the release above runs on the store rather than
  // in a render, so for one render the hold can still be the old selection's.
  const held = holding && holding.filter === selected?.filter ? holding.entries : null;

  return {
    selected,
    live,
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
 * The column answers one question — what has arrived on this topic — so only arrivals belong in it.
 *
 * A command entry's `topic` is what the command was aimed at: a filter, possibly a wildcard, or
 * a count like '3 filters'. Matching that against the selection reads as traffic that never
 * happened — 'Subscribed to sensors/#' would sit under a selected sensors/# looking like an
 * arrival on a topic no broker ever published to.
 */
function carriesTraffic(entry: LogEntry, filter: string): boolean {
  return entry.kind === 'recv' && !!entry.topic && matchesFilter(filter, entry.topic);
}
