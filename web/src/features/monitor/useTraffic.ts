import { useCallback, useMemo } from 'react';
import { canHold } from '../../lib/holds';
import { found } from '../../lib/sift';
import { matchesFilter } from '../../lib/topicMatch';
import { useHoldStore, useShown } from '../../stores/holdStore';
import { useLogStore, type LogEntry } from '../../stores/logStore';
import { useSearchStore } from '../../stores/searchStore';
import { useSelectionStore } from '../../stores/selectionStore';

/**
 * The run of traffic the right column is reading.
 *
 * The entries, the chart and the count all answer for the same run, and they sit in three separate
 * regions of the column — so the run itself cannot live inside any one of them. It is read off the
 * shared view in holdStore, which works it out once per change for every reader and draws what the
 * holds are keeping still exactly as the tree does.
 */

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
  /** What the column is showing, one run per topic — the shape a chart draws from. */
  runs: LogEntry[][];
  /** The same, merged newest first. Merged only when somebody reads it. */
  readonly entries: LogEntry[];
  /** Whether anything on show is held still — all of it, or the part a hold beneath it covers. */
  held: boolean;
  /** The newest command that failed on this selection and has not since succeeded. */
  fault: LogEntry | null;
  /** Every entry on show is the same topic, so naming it on each of them says nothing new. */
  single: boolean;
};

/** How many entries the selection shows, and nothing else — a badge must not merge a run. */
export function useTrafficCount(): number {
  const selected = useSelectionStore((state) => state.selected);

  return useShown(selected?.filter).count;
}

/**
 * The pause, for a control that is not in the pane it pauses.
 *
 * About the filter it was given, or whatever is selected. A control on a row that is not the
 * selected one is how a reader lets go of a topic they paused and then went to look at something
 * else. Taking the hold freezes the shown view at the click; see holdStore.
 */
export function useHoldControl(over?: string): {
  can: boolean;
  held: boolean;
  arrived: number;
  toggle: () => void;
} {
  const selected = useSelectionStore((state) => state.selected?.filter);
  const filter = over ?? selected;
  const can = canHold(filter);
  const shown = useShown(can ? filter : undefined);
  const held = shown.state.own !== null;

  const toggle = useCallback(() => {
    if (!canHold(filter)) return;

    const holds = useHoldStore.getState();
    if (holds.held.has(filter)) holds.release(filter);
    else holds.take(filter);
  }, [filter]);

  return { can, held, arrived: held ? shown.arrived : 0, toggle };
}

export function useTraffic(): Traffic {
  // Only the commands: this is read to explain a silence, and what explains one is what this
  // console tried and was refused, never the traffic itself.
  const commands = useLogStore((state) => state.commands);
  const selected = useSelectionStore((state) => state.selected);
  const shown = useShown(selected?.filter);

  // Only worth looking for while the selection has nothing to show; that is the one moment a
  // reader is asking why.
  const fault = useMemo(
    () => (selected && shown.count === 0 ? faultOn(commands, selected.filter) : null),
    [commands, selected, shown.count],
  );

  return {
    selected,
    runs: shown.runs,
    get entries() {
      return shown.entries;
    },
    held: shown.state.over !== null || shown.state.touched,
    fault,
    single: shown.runs.length <= 1,
  };
}

/**
 * The rows the log pane draws: the run the selection shows, narrowed by what the reader is looking
 * for. Only the rows — the chart goes on drawing the whole run.
 */
export function useShownEntries(): { readonly entries: LogEntry[]; all: number; sought: boolean } {
  const selected = useSelectionStore((state) => state.selected);
  const shown = useShown(selected?.filter);
  const { look, where } = useSearchStore((state) => state.log);

  const narrowed = useMemo(
    () =>
      look === ''
        ? null
        : shown.entries.filter((entry) => found({ topic: entry.topic, body: entry.body }, look, where)),
    [shown, look, where],
  );

  return {
    get entries() {
      return narrowed ?? shown.entries;
    },
    all: shown.count,
    sought: look !== '',
  };
}
