import { create } from 'zustand';
import type { FlowDebugDto, FlowNodeStatusDto, FlowRunStatusDto, FlowStatusDto } from '../types/api';

/** How many debug lines the console keeps for each flow. The strip is for the last minute, not a log. */
export const DEBUG_KEPT = 200;

/** The key one node's numbers are kept under. */
export const nodeKey = (flowId: string, nodeId: string) => `${flowId}/${nodeId}`;

/** A debug line as the console keeps it: the server's line, and where it came in the order they arrived. */
export type DebugLine = FlowDebugDto & { seq: number };

type FlowStatusState = {
  /** Running flows by id. A flow missing here is not running. */
  flows: Record<string, FlowRunStatusDto>;
  /** Every running node, by nodeKey, so one node on the canvas subscribes to one entry. */
  nodes: Record<string, FlowNodeStatusDto>;
  /** Each flow's debug lines, newest first, DEBUG_KEPT at most for each. */
  debug: Record<string, DebugLine[]>;
  /** Lines the server left out since the console opened. It says how many, never whose. */
  debugDropped: number;
  /** What debugDropped stood at when each flow's strip was last cleared. */
  debugClearedAt: Record<string, number>;
  setStatus: (status: FlowStatusDto) => void;
  addDebug: (entries: FlowDebugDto[], dropped: number) => void;
  /** Empties one flow's strip, and starts its count of lines left out again. */
  clearDebug: (flowId: string) => void;
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
 * What the running flows have done, as the server last said.
 *
 * In the main chunk rather than with the page, because the hub bridge feeds it from the moment
 * the console opens: a page opened a minute later shows numbers straight away rather than zeroes
 * until the next push. Each push replaces the whole picture — the server sends every running flow
 * every time — so a flow that stopped simply disappears from it.
 */
export const useFlowStatusStore = create<FlowStatusState>()((set) => ({
  flows: {},
  nodes: {},
  debug: {},
  debugDropped: 0,
  debugClearedAt: {},

  setStatus: (status) => {
    const flows: Record<string, FlowRunStatusDto> = {};
    const nodes: Record<string, FlowNodeStatusDto> = {};

    for (const flow of status.flows) {
      flows[flow.id] = flow;
      for (const node of flow.nodes) nodes[nodeKey(flow.id, node.id)] = node;
    }

    set({ flows, nodes });
  },

  // A batch arrives oldest first; the strip reads newest first. Each flow keeps its own last
  // DEBUG_KEPT, because the strip shows one flow at a time, and one that prints on every message
  // would otherwise push a quiet one's lines out before anybody switched to its tab.
  addDebug: (entries, dropped) =>
    set((state) => {
      const added: Record<string, DebugLine[]> = {};
      for (const entry of entries) (added[entry.flowId] ??= []).push({ ...entry, seq: ++arrived });

      const debug = entries.length === 0 ? state.debug : { ...state.debug };
      for (const [flowId, lines] of Object.entries(added))
        debug[flowId] = [...lines.reverse(), ...(state.debug[flowId] ?? [])].slice(0, DEBUG_KEPT);

      return { debug, debugDropped: state.debugDropped + dropped };
    }),

  clearDebug: (flowId) =>
    set((state) => ({
      debug: without(state.debug, flowId),
      debugClearedAt: { ...state.debugClearedAt, [flowId]: state.debugDropped },
    })),
}));
