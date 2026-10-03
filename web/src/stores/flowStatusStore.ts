import { create } from 'zustand';
import { getFlowStatus } from '../api/flows';
import type { FlowDebugDto, FlowNodeStatusDto, FlowRunStatusDto, FlowStatusDto } from '../types/api';

/** How many debug lines the console keeps for each flow. The strip is for the last minute, not a log. */
export const DEBUG_KEPT = 200;

/** The key one node's numbers are kept under. */
export const nodeKey = (flowId: string, nodeId: string) => `${flowId}/${nodeId}`;

/** A debug line as the console keeps it: the server's line, and where it came in the order they arrived. */
export type DebugLine = FlowDebugDto & { seq: number };

/** A flow's two runs: the flow at work, and a test of its draft. Either may be missing. */
export type FlowRuns = { active?: FlowRunStatusDto; test?: FlowRunStatusDto };

/** Going or waiting: not finished at an End and not stopped. */
export const isLive = (run: FlowRunStatusDto | undefined) => run?.state === 'running' || run?.state === 'waiting';

/**
 * The run a flow's canvas shows: a test that is going, else the active run, else a test that has
 * ended. A reader who pressed Test is looking at the test; one who did not is looking at the flow at
 * work; and a test that has finished is still worth reading until something replaces it.
 */
export function shownRun(runs: FlowRuns | undefined): FlowRunStatusDto | undefined {
  if (!runs) return undefined;
  if (isLive(runs.test)) return runs.test;
  return runs.active ?? runs.test;
}

type FlowStatusState = {
  /** Every flow's runs, by flow id. A flow missing here is neither switched on nor being tested. */
  runs: Record<string, FlowRuns>;
  /** The nodes of the run each flow's canvas shows (see shownRun), by nodeKey, so a node subscribes to one entry. */
  nodes: Record<string, FlowNodeStatusDto>;
  /** Each flow's debug lines, newest first, DEBUG_KEPT at most for each. */
  debug: Record<string, DebugLine[]>;
  /** Lines the server left out since the console opened. It says how many, never whose. */
  debugDropped: number;
  /** What debugDropped stood at when each flow's strip was last cleared. */
  debugClearedAt: Record<string, number>;
  /**
   * The flows deleted since the console opened. A batch the server sent before a delete landed
   * can arrive after it, and its lines are dropped rather than kept under a flow with no strip.
   */
  deleted: Record<string, true>;
  setStatus: (status: FlowStatusDto) => void;
  addDebug: (entries: FlowDebugDto[], dropped: number) => void;
  /** Empties one flow's strip, and starts its count of lines left out again. */
  clearDebug: (flowId: string) => void;
  /**
   * The flow was deleted: its lines, and where its strip was last cleared, go with it, and any
   * that come for it later are dropped. Nothing else would let them go — a strip's own Clear is the
   * only other way, and it has no strip now.
   */
  forget: (flowId: string) => void;
};

/**
 * How many lines the server has left out since a flow's strip was last cleared. From any flow: the
 * server counts what it leaves out, not whose it was, so this is never one flow's own figure.
 */
export const leftOut = (state: FlowStatusState, flowId: string) =>
  state.debugDropped - (state.debugClearedAt[flowId] ?? 0);

/**
 * The number the next debug line gets. Never reset, so no two lines in one console share one, and
 * a line keeps its number — and the strip keeps its row, and any text selected in it — however many
 * newer lines arrive above it.
 */
let arrived = 0;

const without = <T>(record: Record<string, T>, key: string): Record<string, T> =>
  Object.fromEntries(Object.entries(record).filter(([id]) => id !== key));

/**
 * What the runs have done, as the server last said.
 *
 * In the main chunk rather than with the page, because the hub bridge feeds it from the moment
 * the console opens: a page opened a minute later shows numbers straight away rather than zeroes
 * until the next push. Each push replaces the whole picture — the server sends every run there is
 * every time — so a run that went simply disappears from it.
 */
export const useFlowStatusStore = create<FlowStatusState>()((set) => ({
  runs: {},
  nodes: {},
  debug: {},
  debugDropped: 0,
  debugClearedAt: {},
  deleted: {},

  setStatus: (status) => {
    const runs: Record<string, FlowRuns> = {};
    for (const run of status.runs) (runs[run.flowId] ??= {})[run.kind] = run;

    const nodes: Record<string, FlowNodeStatusDto> = {};
    for (const [flowId, both] of Object.entries(runs))
      for (const node of shownRun(both)?.nodes ?? []) nodes[nodeKey(flowId, node.id)] = node;

    set({ runs, nodes });
  },

  // A batch arrives oldest first; the strip reads newest first. Each flow keeps its own last
  // DEBUG_KEPT, because the strip shows one flow at a time, and one that prints on every message
  // would otherwise push a quiet one's lines out before anybody switched to its tab.
  addDebug: (entries, dropped) =>
    set((state) => {
      const added: Record<string, DebugLine[]> = {};
      for (const entry of entries)
        if (!(entry.flowId in state.deleted)) (added[entry.flowId] ??= []).push({ ...entry, seq: ++arrived });

      const debug = Object.keys(added).length === 0 ? state.debug : { ...state.debug };
      for (const [flowId, lines] of Object.entries(added))
        debug[flowId] = [...lines.reverse(), ...(state.debug[flowId] ?? [])].slice(0, DEBUG_KEPT);

      return { debug, debugDropped: state.debugDropped + dropped };
    }),

  clearDebug: (flowId) =>
    set((state) => ({
      debug: without(state.debug, flowId),
      debugClearedAt: { ...state.debugClearedAt, [flowId]: state.debugDropped },
    })),

  forget: (flowId) =>
    set((state) => ({
      debug: without(state.debug, flowId),
      debugClearedAt: without(state.debugClearedAt, flowId),
      deleted: { ...state.deleted, [flowId]: true },
    })),
}));

/**
 * Reads the numbers from the server, for a reader that may have missed pushes: a page just opened,
 * a hub just back.
 *
 * Pushes carry nothing to put them in order by, so the answer is kept only if no push has come in
 * while it was out: one that has is newer than the answer. Every push builds a new picture, which is
 * what makes an identity check enough. Hands back what lets the answer go, for a reader that has
 * shut before it comes back.
 */
export function catchUp(): () => void {
  let wanted = true;
  const asked = useFlowStatusStore.getState().runs;

  getFlowStatus().then(
    (status) => {
      if (wanted && useFlowStatusStore.getState().runs === asked) useFlowStatusStore.getState().setStatus(status);
    },
    () => {},
  );

  return () => {
    wanted = false;
  };
}
