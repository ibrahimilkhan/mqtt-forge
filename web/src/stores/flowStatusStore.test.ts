import { beforeEach, describe, expect, it } from 'vitest';
import type { FlowDebugDto, FlowStatusDto } from '../types/api';
import { DEBUG_KEPT, leftOut, nodeKey, useFlowStatusStore } from './flowStatusStore';

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

const line = (text: string, flowId = 'watch'): FlowDebugDto => ({
  flowId,
  nodeId: 'say',
  at: '2026-09-26T09:14:22.000Z',
  kind: 'message',
  topic: 'plant/k1/temp',
  text,
});

const state = () => useFlowStatusStore.getState();
const texts = (flowId: string) => (state().debug[flowId] ?? []).map((entry) => entry.text);

describe('flow status store', () => {
  beforeEach(() => useFlowStatusStore.setState(useFlowStatusStore.getInitialState()));

  it('keeps each running flow and each node under its own key', () => {
    state().setStatus(status);

    expect(Object.keys(state().flows)).toEqual(['watch']);
    expect(state().nodes[nodeKey('watch', 'test')].outs).toEqual({ yes: 3, no: 409 });
  });

  it('replaces the whole picture, so a flow that stopped is gone', () => {
    state().setStatus(status);
    state().setStatus({ flows: [] });

    expect(state().flows).toEqual({});
    expect(state().nodes).toEqual({});
  });

  it('keeps debug lines newest first, and no more than it keeps', () => {
    state().addDebug([line('a'), line('b')], 0);
    state().addDebug([line('c')], 0);

    expect(texts('watch')).toEqual(['c', 'b', 'a']);

    state().addDebug(Array.from({ length: DEBUG_KEPT + 5 }, (_, i) => line(String(i))), 0);
    expect(state().debug.watch).toHaveLength(DEBUG_KEPT);
  });

  // The strip shows one flow's lines. Kept all together, a flow printing on every message would
  // push a quiet one's lines out of the store before anybody switched to its tab.
  it('keeps each flow its own lines, so a busy flow cannot push a quiet one out', () => {
    state().addDebug([line('quiet', 'watch')], 0);
    state().addDebug(Array.from({ length: DEBUG_KEPT + 5 }, (_, i) => line(String(i), 'busy')), 0);

    expect(texts('watch')).toEqual(['quiet']);
    expect(state().debug.busy).toHaveLength(DEBUG_KEPT);
  });

  it('clears one flow\'s lines and leaves the others', () => {
    state().addDebug([line('a', 'watch'), line('b', 'busy')], 0);

    state().clearDebug('watch');

    expect(texts('watch')).toEqual([]);
    expect(texts('busy')).toEqual(['b']);
  });

  // A line keeps the number it came with, so the strip can keep its row, and whatever the reader
  // has selected in it, as newer lines arrive above.
  it('numbers each line in the order it came, and never renumbers one', () => {
    state().addDebug([line('a'), line('b')], 0);
    const [b, a] = state().debug.watch;
    expect(b.seq).toBeGreaterThan(a.seq);

    state().addDebug([line('c')], 0);

    const [c, ...rest] = state().debug.watch;
    expect(rest).toEqual([b, a]);
    expect(c.seq).toBeGreaterThan(b.seq);
  });

  // The server counts what it left out, not whose it was, so no strip can claim the count as its
  // own. Each strip counts from when it was last cleared.
  it('counts the lines left out from every flow, for each strip from its last Clear', () => {
    state().addDebug([line('a', 'watch')], 3);
    expect(leftOut(state(), 'watch')).toBe(3);
    expect(leftOut(state(), 'busy')).toBe(3);

    state().clearDebug('watch');
    state().addDebug([], 2);

    expect(leftOut(state(), 'watch')).toBe(2);
    expect(leftOut(state(), 'busy')).toBe(5);
  });
});
