import { create } from 'zustand';
import type { FlowDebugDto, FlowNodeStatusDto, FlowRunStatusDto, FlowStatusDto } from '../types/api';

/** How many debug lines the console keeps. The strip is for the last minute, not a log. */
export const DEBUG_KEPT = 200;

/** The key one node's numbers are kept under. */
export const nodeKey = (flowId: string, nodeId: string) => `${flowId}/${nodeId}`;

type FlowStatusState = {
  /** Running flows by id. A flow missing here is not running. */
  flows: Record<string, FlowRunStatusDto>;
  /** Every running node, by nodeKey, so one node on the canvas subscribes to one entry. */
  nodes: Record<string, FlowNodeStatusDto>;
  /** Newest first. */
  debug: FlowDebugDto[];
  /** Lines the server had to leave out since the strip was last cleared. */
  debugDropped: number;
  setStatus: (status: FlowStatusDto) => void;
  addDebug: (entries: FlowDebugDto[], dropped: number) => void;
  clearDebug: () => void;
};

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
  debug: [],
  debugDropped: 0,

  setStatus: (status) => {
    const flows: Record<string, FlowRunStatusDto> = {};
    const nodes: Record<string, FlowNodeStatusDto> = {};

    for (const flow of status.flows) {
      flows[flow.id] = flow;
      for (const node of flow.nodes) nodes[nodeKey(flow.id, node.id)] = node;
    }

    set({ flows, nodes });
  },

  // A batch arrives oldest first; the strip reads newest first.
  addDebug: (entries, dropped) =>
    set((state) => ({
      debug: [...entries.slice().reverse(), ...state.debug].slice(0, DEBUG_KEPT),
      debugDropped: state.debugDropped + dropped,
    })),

  clearDebug: () => set({ debug: [], debugDropped: 0 }),
}));
