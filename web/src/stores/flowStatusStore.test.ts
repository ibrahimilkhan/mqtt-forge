import { beforeEach, describe, expect, it } from 'vitest';
import type { FlowDebugDto, FlowStatusDto } from '../types/api';
import { DEBUG_KEPT, nodeKey, useFlowStatusStore } from './flowStatusStore';

const status: FlowStatusDto = {
  flows: [
    {
      id: 'watch',
      faults: 0,
      fault: null,
      nodes: [
        { id: 'in', count: 412, outs: { out: 412 }, errors: 0, note: '{"temp":94.2}', standing: [] },
        { id: 'test', count: 412, outs: { yes: 3, no: 409 }, errors: 0, note: '94.2', standing: [] },
      ],
    },
  ],
};

const line = (text: string): FlowDebugDto => ({
  flowId: 'watch',
  nodeId: 'say',
  at: '2026-09-26T09:14:22.000Z',
  kind: 'message',
  topic: 'plant/k1/temp',
  text,
});

describe('flow status store', () => {
  beforeEach(() => useFlowStatusStore.setState({ flows: {}, nodes: {}, debug: [], debugDropped: 0 }));

  it('keeps each running flow and each node under its own key', () => {
    useFlowStatusStore.getState().setStatus(status);

    const state = useFlowStatusStore.getState();
    expect(Object.keys(state.flows)).toEqual(['watch']);
    expect(state.nodes[nodeKey('watch', 'test')].outs).toEqual({ yes: 3, no: 409 });
  });

  it('replaces the whole picture, so a flow that stopped is gone', () => {
    useFlowStatusStore.getState().setStatus(status);
    useFlowStatusStore.getState().setStatus({ flows: [] });

    expect(useFlowStatusStore.getState().flows).toEqual({});
    expect(useFlowStatusStore.getState().nodes).toEqual({});
  });

  it('keeps debug lines newest first, and no more than it keeps', () => {
    useFlowStatusStore.getState().addDebug([line('a'), line('b')], 0);
    useFlowStatusStore.getState().addDebug([line('c')], 3);

    expect(useFlowStatusStore.getState().debug.map((entry) => entry.text)).toEqual(['c', 'b', 'a']);
    expect(useFlowStatusStore.getState().debugDropped).toBe(3);

    useFlowStatusStore.getState().addDebug(Array.from({ length: DEBUG_KEPT + 5 }, (_, i) => line(String(i))), 0);
    expect(useFlowStatusStore.getState().debug).toHaveLength(DEBUG_KEPT);
  });

  it('clears the strip and what it had dropped', () => {
    useFlowStatusStore.getState().addDebug([line('a')], 2);
    useFlowStatusStore.getState().clearDebug();

    expect(useFlowStatusStore.getState().debug).toEqual([]);
    expect(useFlowStatusStore.getState().debugDropped).toBe(0);
  });
});
