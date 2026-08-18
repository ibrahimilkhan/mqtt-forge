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

export type Traffic = {
  selected: ReturnType<typeof useSelectionStore.getState>['selected'];
  /** What the log holds on the selection right now, whatever the column is showing. */
  live: LogEntry[];
  /** What the column is showing: the live run, or the one the hold froze. */
  entries: LogEntry[];
  held: boolean;
  /** How much has arrived behind the hold — nothing to say while the column is live. */
  arrived: number;
};

export function useTraffic(): Traffic {
  const log = useLogStore((state) => state.entries);
  const selected = useSelectionStore((state) => state.selected);
  const holding = useHoldStore((state) => state.held);

  const live = useMemo(
    () => (selected ? log.filter((entry) => carriesTraffic(entry, selected.filter)) : []),
    [log, selected],
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
