import { create } from 'zustand';
import { getAlerts } from '../api/alerts';
import type {
  AlertDto,
  AlertsDto,
  CappedRuleDto,
  MutedPairDto,
  RuleDiagnosticDto,
  WarmingPairDto,
} from '../types/api';

/**
 * How much history the console keeps between snapshots.
 *
 * The engine's own HistoryDepth, mirrored: it holds five hundred closed alarms and the next
 * snapshot replaces this list with them, so a console keeping more would only be holding rows
 * that are about to be thrown away by an answer that never had them.
 */
export const HISTORY_DEPTH = 500;

/**
 * One thing the hub said, kept until the snapshot it arrived behind has landed.
 *
 * A union rather than a queue of closures, so that a replay is inspectable in a debugger and in a
 * test: 'what is this console holding' has an answer somebody can read.
 */
type PendingEvent =
  | { kind: 'raised'; alerts: AlertDto[] }
  | { kind: 'resolved'; alerts: AlertDto[] }
  | { kind: 'mute'; ruleId: string; topic: string; until: string | null }
  | { kind: 'dropped'; total: number };

/** The engine as of one moment: exactly what GET /api/alerts answers, and nothing else. */
export type AlertSnapshotState = {
  active: AlertDto[];
  history: AlertDto[];
  muted: MutedPairDto[];
  rules: RuleDiagnosticDto[];
  warming: WarmingPairDto[];
  capped: CappedRuleDto[];
  dropped: number;
  webhooksDropped: number;
  suppressed: number;
  blindSeconds: number;
};

export type AlertState = AlertSnapshotState & {
  /** A snapshot is in flight, and what the hub says is waiting behind it. */
  syncing: boolean;
  /**
   * What is waiting. Internal, and in the state rather than in a module variable so that a test
   * resetting this store resets the queue with it.
   */
  pending: PendingEvent[];
  /** Takes a fresh snapshot and REPLACES everything with it. */
  load: () => Promise<void>;
  raised: (alerts: AlertDto[]) => void;
  resolved: (alerts: AlertDto[]) => void;
  /**
   * A pair was silenced, or a silence was lifted — null is the lift.
   *
   * Named `mute` and not `muted`, which is what the hub event is called, because `muted` is the
   * list of silenced pairs on the state beside it and one name cannot be both.
   */
  mute: (ruleId: string, topic: string, until: string | null) => void;
  droppedTotal: (total: number) => void;
};

/** Nothing known yet: the state before the first snapshot, and what a test resets to. */
export const emptyAlerts = (): AlertSnapshotState & Pick<AlertState, 'syncing' | 'pending'> => ({
  active: [],
  history: [],
  muted: [],
  rules: [],
  warming: [],
  capped: [],
  dropped: 0,
  webhooksDropped: 0,
  suppressed: 0,
  blindSeconds: 0,
  syncing: false,
  pending: [],
});

/**
 * Which snapshot is the current one.
 *
 * A reconnect can start a second load while the first is still in flight, and the first is then
 * stale twice over: its lists are older, and — worse — draining the queue would empty the very
 * thing the newer load is relying on to catch what its own snapshot misses.
 */
let generation = 0;

export const useAlertStore = create<AlertState>((set, get) => ({
  ...emptyAlerts(),

  load: async () => {
    const mine = ++generation;
    set({ syncing: true });

    let snapshot: AlertsDto | undefined;

    try {
      snapshot = await getAlerts();
    } catch {
      // Swallowed deliberately. This runs on every connect and every reconnect, and an API that
      // is not up yet is the ordinary case at start-up rather than something to put in front of
      // a reader. What is NOT swallowed is the queue below: those events happened whatever the
      // GET did, and letting them go would lose alarms this console has already been told about.
    }

    // A newer load owns the answer and the queue both.
    if (mine !== generation) return;

    // REPLACED, never merged, and this is the whole reason the snapshot is taken again after a
    // reconnect: an alertsResolved that never arrived leaves an alarm standing on screen for
    // ever, and the only thing that can put that right is a list that does not contain it.
    if (snapshot) set(taken(snapshot));

    // Cleared before the drain, so the actions below apply rather than queue themselves again.
    set({ syncing: false });

    // In the order they arrived. Every one of them is idempotent — raise replaces on the id,
    // resolve removes on it, a mute is keyed on its pair and the dropped total only climbs — so
    // an event the snapshot already knew about costs nothing to see twice.
    for (const event of get().pending.splice(0)) apply(get(), event);
  },

  raised: (alerts) => {
    if (queued(get(), { kind: 'raised', alerts })) return;

    set((state) => ({ active: merged(state.active, alerts) }));
  },

  resolved: (alerts) => {
    if (queued(get(), { kind: 'resolved', alerts })) return;

    set((state) => {
      const gone = new Set(alerts.map((alert) => alert.id));

      return {
        active: state.active.filter((alert) => !gone.has(alert.id)),
        // The resolved copies go to the head of the history, because they are the ones carrying
        // resolvedAt and resolvedBy — the active copy has neither, and 'why did it stop' is the
        // whole reason anybody opens the history. Filtered first so a replay cannot double a row.
        history: [
          ...alerts,
          ...state.history.filter((alert) => !gone.has(alert.id)),
        ].slice(0, HISTORY_DEPTH),
      };
    });
  },

  mute: (ruleId, topic, until) => {
    if (queued(get(), { kind: 'mute', ruleId, topic, until })) return;

    set((state) => {
      const others = state.muted.filter((pair) => pair.ruleId !== ruleId || pair.topic !== topic);

      return { muted: until === null ? others : [...others, { ruleId, topic, until }] };
    });
  },

  droppedTotal: (total) => {
    if (queued(get(), { kind: 'dropped', total })) return;

    // Forward only. The hub sends this on a change, the queue above can replay one late, and a
    // figure that walked backwards would be the console saying the engine had un-dropped
    // something. An engine that restarted and began counting again is put right by the next
    // snapshot, which replaces this number rather than climbing to it.
    set((state) => (total > state.dropped ? { dropped: total } : {}));
  },
}));

/**
 * When this pair goes back to speaking, or undefined if it is not silenced now.
 *
 * One answer in one place, because there are two things on this state that could be asked: the
 * pair list, which survives the alarm it was set on, and `mutedUntil` on an alert, which is what
 * the server happened to know when the snapshot was taken. The pair list is the one that is kept
 * up to date by the hub, so it is the one that answers — and an expired mute is not one, which is
 * what stops a page left open overnight showing a silence that lifted hours ago.
 */
export function mutedUntil(
  state: AlertState,
  ruleId: string,
  topic: string,
  now: number = Date.now(),
): string | undefined {
  const pair = state.muted.find((held) => held.ruleId === ruleId && held.topic === topic);
  if (!pair) return undefined;

  return Date.parse(pair.until) > now ? pair.until : undefined;
}

/**
 * Whether this event has to wait for the snapshot in flight.
 *
 * It has to, and the reason is one failure: an alertsResolved applied before a snapshot that
 * still holds its alarm would be undone by that snapshot, and the row would stand for ever with
 * nothing left to take it away.
 */
function queued(state: AlertState, event: PendingEvent): boolean {
  if (!state.syncing) return false;

  // Mutated in place, like the log's own map and for the same reason: nobody renders this, and a
  // fresh array per event would wake every subscriber for something none of them can see.
  state.pending.push(event);

  return true;
}

function apply(state: AlertState, event: PendingEvent): void {
  switch (event.kind) {
    case 'raised':
      state.raised(event.alerts);
      return;
    case 'resolved':
      state.resolved(event.alerts);
      return;
    case 'mute':
      state.mute(event.ruleId, event.topic, event.until);
      return;
    case 'dropped':
      state.droppedTotal(event.total);
      return;
  }
}

/**
 * Copied member by member rather than spread, so a member the server adds later cannot land in
 * this store as a field nothing here declares, and so the lists are this store's own rather than
 * the response body's. `capped` is spread like the rest because it is a list of capped rules —
 * a count would make this line throw, which is exactly the point of copying rather than trusting.
 */
function taken(snapshot: AlertsDto): AlertSnapshotState {
  return {
    active: [...snapshot.active],
    history: [...snapshot.history],
    muted: [...snapshot.muted],
    rules: [...snapshot.rules],
    warming: [...snapshot.warming],
    capped: [...snapshot.capped],
    dropped: snapshot.dropped,
    webhooksDropped: snapshot.webhooksDropped,
    suppressed: snapshot.suppressed,
    blindSeconds: snapshot.blindSeconds,
  };
}

/**
 * Replace-or-append on the id, rather than a plain push.
 *
 * Twice over: the queue above replays what a snapshot may already have held, and the engine
 * re-announces every standing alarm after its own restart. An alarm appearing twice in the active
 * list would be two rows the reader has to mute separately, and one of them would never go away.
 */
function merged(active: AlertDto[], arriving: AlertDto[]): AlertDto[] {
  const held = [...active];

  for (const alert of arriving) {
    const at = held.findIndex((standing) => standing.id === alert.id);

    if (at >= 0) held[at] = alert;
    else held.push(alert);
  }

  return held;
}
