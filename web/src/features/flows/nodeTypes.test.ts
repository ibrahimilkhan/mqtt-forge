import { describe, expect, it } from 'vitest';
import type { FlowNodeStatusDto } from '../../types/api';
import { GROUPS, isNodeType, NODE_SPECS, specOf } from './nodeTypes';

const counted = (over: Partial<FlowNodeStatusDto>): FlowNodeStatusDto => ({
  id: 'n', count: 0, outs: {}, errors: 0, note: null, standing: [], ...over,
});

describe('node registry', () => {
  it('has the server\'s ports for every type', () => {
    // Part 1's FlowPorts, one for one. A port here and not there is a wire the server refuses.
    expect(Object.fromEntries(Object.values(NODE_SPECS).map((spec) => [spec.type, [spec.ins, spec.outs]]))).toEqual({
      mqttIn: [[], ['out']],
      every: [[], ['out']],
      inject: [[], ['out']],
      if: [['in'], ['yes', 'no']],
      forEach: [['in'], ['out']],
      repeat: [['in'], ['out']],
      alarm: [['raise', 'clear'], []],
      publish: [['in'], []],
      debug: [['in'], []],
    });
  });

  it('puts every type in one of three groups, in palette order', () => {
    expect(GROUPS).toEqual(['Triggers', 'Logic', 'Actions']);
    for (const spec of Object.values(NODE_SPECS)) expect(GROUPS).toContain(spec.group);
  });

  it('says each node\'s settings in one short line', () => {
    expect(NODE_SPECS.mqttIn.summary({ filter: 'plant/+/temp' })).toBe('plant/+/temp');
    expect(NODE_SPECS.if.summary({ field: '$.temp', test: 'gt', value: '90' })).toBe('$.temp > 90');
    expect(NODE_SPECS.if.summary({ field: '', test: 'between', value: '10', value2: '20' })).toBe('payload between 10 and 20');
    expect(NODE_SPECS.if.summary({ field: '$.fault', test: 'exists' })).toBe('$.fault exists');
    expect(NODE_SPECS.every.summary({ seconds: 2 })).toBe('every 2 s');
    expect(NODE_SPECS.repeat.summary({ count: 3, seconds: 0 })).toBe('3 times at once');
    expect(NODE_SPECS.repeat.summary({ count: 3, seconds: '1.5' })).toBe('3 times, 1.5 s apart');
    expect(NODE_SPECS.alarm.summary({ name: 'Too hot', severity: 'critical' })).toBe('critical · Too hot');
    // Written by hand with no level, or one the server does not know: it says "Pick a level", and
    // the node does not claim one.
    expect(NODE_SPECS.alarm.summary({ name: 'Too hot' })).toBe('no level · Too hot');
    expect(NODE_SPECS.alarm.summary({ name: 'Too hot', severity: 'loud' })).toBe('no level · Too hot');
    expect(NODE_SPECS.publish.summary({ topic: 'plant/{{topic[1]}}/cmd' })).toBe('plant/{{topic[1]}}/cmd');
  });

  it('says what a node has done from the server\'s counters', () => {
    expect(NODE_SPECS.mqttIn.status(counted({ count: 412 }))).toBe('412 in');
    expect(NODE_SPECS.if.status(counted({ outs: { yes: 3, no: 409 } }))).toBe('yes 3 · no 409');
    expect(NODE_SPECS.if.status(counted({ outs: { yes: 1, skipped: 2 } }))).toBe('yes 1 · no 0 · 2 skipped');
    expect(NODE_SPECS.publish.status(counted({ outs: { sent: 12 }, errors: 2 }))).toBe('12 sent · 2 errors');
    expect(NODE_SPECS.alarm.status(counted({ outs: { raised: 4 }, standing: [{ topic: 'a', firedAt: '', reason: '', count: 1 }] })))
      .toBe('1 up · 4 raised');
  });

  it('knows its own names', () => {
    expect(isNodeType('forEach')).toBe(true);
    expect(isNodeType('teleport')).toBe(false);
  });

  // The server keeps a flow a newer build wrote, whatever its nodes are, and hands it back.
  it('draws a type it does not know by that type\'s own name, with no ports of its own', () => {
    const spec = specOf('function');

    expect(spec).toMatchObject({ label: 'function', ins: [], outs: [] });
    expect(spec.summary({ code: 'return msg;' })).toBe('not known to this build');
    expect(spec.status(counted({ count: 2, errors: 1 }))).toBe('2 in · 1 error');
    expect(specOf('if')).toBe(NODE_SPECS.if);
  });
});
