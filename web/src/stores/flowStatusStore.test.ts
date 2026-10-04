import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FlowDebugDto, FlowRunStatusDto, FlowStatusDto } from '../types/api';
import { DEBUG_KEPT, isLive, leftOut, nodeKey, shownRun, useFlowStatusStore } from './flowStatusStore';

const run = (over: Partial<FlowRunStatusDto> = {}): FlowRunStatusDto => ({
  flowId: 'watch',
  kind: 'active',
  state: 'waiting',
  at: 'in',
  waiting: { until: null, filter: 'plant/+/temp' },
  fault: null,
  variables: { limit: '90' },
  nodes: [
    { id: 'in', count: 412, outs: { out: 412 }, errors: 0, note: '{"temp":94.2}', standing: [] },
    { id: 'test', count: 412, outs: { yes: 3, no: 409 }, errors: 0, note: '94.2', standing: [] },
  ],
  ...over,
});

const status: FlowStatusDto = { runs: [run()] };

const line = (text: string, flowId = 'watch'): FlowDebugDto => ({
  flowId,
  nodeId: 'say',
  at: '2026-09-26T09:14:22.000Z',
  kind: 'message',
  topic: 'plant/k1/temp',
  text,
  test: false,
});

const state = () => useFlowStatusStore.getState();
const texts = (flowId: string) => (state().debug[flowId] ?? []).map((entry) => entry.text);

describe('flow status store', () => {
  beforeEach(() => useFlowStatusStore.setState(useFlowStatusStore.getInitialState()));

  it('keeps each flow\'s runs, and the nodes of the run its canvas shows under their own keys', () => {
    state().setStatus(status);

    expect(Object.keys(state().runs)).toEqual(['watch']);
    expect(state().runs.watch.active?.variables).toEqual({ limit: '90' });
    expect(state().nodes[nodeKey('watch', 'test')].outs).toEqual({ yes: 3, no: 409 });
  });

  it('files each run under its flow and its kind, so one flow\'s runs never stand for another\'s', () => {
    state().setStatus({ runs: [run(), run({ flowId: 'sim', kind: 'test' })] });

    expect(Object.keys(state().runs).sort()).toEqual(['sim', 'watch']);
    expect(state().runs.watch.test).toBeUndefined();
    expect(state().runs.sim.active).toBeUndefined();
    expect(state().runs.sim.test?.flowId).toBe('sim');
    expect(Object.keys(state().nodes).sort()).toEqual(['sim/in', 'sim/test', 'watch/in', 'watch/test']);
  });

  it('replaces the whole picture, so a run that went is gone', () => {
    state().setStatus(status);
    state().setStatus({ runs: [] });

    expect(state().runs).toEqual({});
    expect(state().nodes).toEqual({});
  });

  // A reader who pressed Test is looking at the test; one who did not is looking at the flow at work.
  it('shows a test that is going, else the active run, else a test that has ended', () => {
    const test = run({ kind: 'test', nodes: [{ id: 'in', count: 1, outs: {}, errors: 0, note: null, standing: [] }] });

    state().setStatus({ runs: [run(), test] });
    expect(shownRun(state().runs.watch)).toBe(state().runs.watch.test);
    expect(state().nodes[nodeKey('watch', 'in')].count).toBe(1);

    state().setStatus({ runs: [run(), { ...test, state: 'finished' }] });
    expect(shownRun(state().runs.watch)?.kind).toBe('active');

    state().setStatus({ runs: [{ ...test, state: 'finished' }] });
    expect(shownRun(state().runs.watch)?.kind).toBe('test');
  });

  it('shows nothing of a flow that has no run', () => {
    expect(shownRun(undefined)).toBeUndefined();
    expect(shownRun({})).toBeUndefined();
  });

  it('calls a run live while it is going or waiting', () => {
    expect(isLive(run({ state: 'running' }))).toBe(true);
    expect(isLive(run({ state: 'waiting' }))).toBe(true);
    expect(isLive(run({ state: 'finished' }))).toBe(false);
    expect(isLive(run({ state: 'stopped' }))).toBe(false);
    expect(isLive(undefined)).toBe(false);
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

  // Only a strip's own Clear let them go, and a deleted flow has no strip left to clear.
  it('forgets a deleted flow\'s lines, and where its strip was last cleared, and keeps the others\'', () => {
    state().addDebug([line('a', 'watch'), line('b', 'busy')], 3);
    state().clearDebug('watch');
    state().clearDebug('busy');
    state().addDebug([line('c', 'watch'), line('d', 'busy')], 0);

    state().forget('watch');

    expect(state().debug.watch).toBeUndefined();
    expect(state().debugClearedAt.watch).toBeUndefined();
    expect(texts('busy')).toEqual(['d']);
    expect(state().debugClearedAt.busy).toBe(3);
  });

  // A batch the server sent before the delete landed can arrive after it, and the lines it brought
  // back would sit under a flow with no strip left to clear them.
  it('drops the lines of a flow deleted in this session, however late they come', () => {
    state().forget('watch');

    state().addDebug([line('late', 'watch'), line('b', 'busy')], 1);

    expect(state().debug.watch).toBeUndefined();
    expect(texts('busy')).toEqual(['b']);
    // What the server says it left out is still counted: it never says whose it was.
    expect(leftOut(state(), 'busy')).toBe(1);
  });

  // Deleted here, then saved again on another console under the same id, and switched on or tested
  // there: a run of it is a flow again, and what it prints is printed. Kept as deleted, it printed
  // nothing in this console for the rest of the session.
  it('prints the lines of a flow deleted here again once the numbers show it running', () => {
    state().forget('watch');
    state().addDebug([line('late', 'watch')], 0);
    expect(state().debug.watch).toBeUndefined();

    state().setStatus({ runs: [run()] });
    state().addDebug([line('again', 'watch')], 0);

    expect(texts('watch')).toEqual(['again']);
  });
});

/**
 * Ids the server's pattern takes, ^[A-Za-z0-9_-]{1,40}$, that every object already answers to: what
 * an object inherits from, the Object function, and a method. A flow can be called any of them.
 */
const INHERITED = ['__proto__', 'constructor', 'toString'];

/** What every object, the Object function and an object's toString would carry, were a run filed on them. */
const everywhere = () => [Object.prototype, Object, Object.prototype.toString] as unknown as Array<Record<string, unknown>>;

describe('flows called by a name every object answers to', () => {
  beforeEach(() => useFlowStatusStore.setState(useFlowStatusStore.getInitialState()));
  // Should a case fail by putting a run on every object, the cases after it must not find it there.
  afterEach(() => {
    for (const each of everywhere()) for (const kind of ['active', 'test']) delete each[kind];
  });

  it('files their runs under their own ids, and puts nothing on every object', () => {
    state().setStatus({ runs: INHERITED.flatMap((flowId) => [run({ flowId }), run({ flowId, kind: 'test', state: 'running' })]) });

    for (const each of everywhere()) {
      expect(each.active).toBeUndefined();
      expect(each.test).toBeUndefined();
    }
    expect(Object.keys(state().runs).sort()).toEqual([...INHERITED].sort());
    for (const flowId of INHERITED) {
      expect(Object.hasOwn(state().runs, flowId)).toBe(true);
      expect(shownRun(state().runs[flowId])?.kind).toBe('test');
      expect(state().nodes[nodeKey(flowId, 'in')].count).toBe(412);
    }
  });

  it('files their debug lines under their own ids, keeps them, and counts what was left out for each strip', () => {
    state().addDebug(INHERITED.map((flowId) => line(`from ${flowId}`, flowId)), 3);

    for (const flowId of INHERITED) {
      expect(Object.hasOwn(state().debug, flowId)).toBe(true);
      expect(texts(flowId)).toEqual([`from ${flowId}`]);
      expect(leftOut(state(), flowId)).toBe(3);
    }

    state().clearDebug('constructor');
    state().addDebug([], 2);
    expect(leftOut(state(), 'constructor')).toBe(2);
    expect(leftOut(state(), 'toString')).toBe(5);
  });

  it('drops the lines of one of them deleted here, and only that one\'s', () => {
    state().forget('constructor');

    state().addDebug(INHERITED.map((flowId) => line(`from ${flowId}`, flowId)), 0);

    expect(Object.hasOwn(state().debug, 'constructor')).toBe(false);
    expect(texts('toString')).toEqual(['from toString']);
    expect(texts('__proto__')).toEqual(['from __proto__']);
  });
});
