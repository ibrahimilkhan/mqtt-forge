import { describe, expect, it } from 'vitest';
import type { FlowDto, FlowNodeStatusDto } from '../../types/api';
import { GROUPS, isLoop, isNodeType, NODE_SPECS, portLabel, sideOf, specOf } from './nodeTypes';

// The server's FlowPorts table, one for one: a port only one side knows is a wire one side refuses.
const SERVER: Record<string, [string[], string[]]> = {
  start: [[], ['out']],
  end: [['in'], []],
  mqttIn: [['in'], ['out']],
  if: [['in'], ['yes', 'no']],
  for: [['in', 'next'], ['body', 'done']],
  forEach: [['in', 'next'], ['body', 'done']],
  wait: [['in'], ['out']],
  set: [['in'], ['out']],
  publish: [['in'], ['out']],
  debug: [['in'], ['out']],
  alarmRaise: [['in'], ['raised', 'up']],
  alarmClear: [['in'], ['cleared', 'none']],
  sound: [['in'], ['out']],
  notify: [['in'], ['out']],
  webhook: [['in'], ['out']],
};

const counted = (over: Partial<FlowNodeStatusDto>): FlowNodeStatusDto => ({
  id: 'n', count: 0, outs: {}, errors: 0, note: null, standing: [], ...over,
});

/** A flow with nothing in it, for the lines that need one to be said and do not read it. */
const nothing: FlowDto = { id: 'f', name: 'F', enabled: false, variables: [], nodes: [], edges: [] };

describe('node registry', () => {
  it("has the server's ports for every type, and no type the server does not know", () => {
    expect(Object.keys(NODE_SPECS).sort()).toEqual(Object.keys(SERVER).sort());
    for (const [type, [ins, outs]] of Object.entries(SERVER)) {
      expect(NODE_SPECS[type as keyof typeof NODE_SPECS].ins).toEqual(ins);
      expect(NODE_SPECS[type as keyof typeof NODE_SPECS].outs).toEqual(outs);
    }
  });

  it('puts every placeable node in one of the four groups, and the Start in none of the palette', () => {
    expect(GROUPS).toEqual(['Input', 'Control', 'Actions', 'Alarm']);
    expect(NODE_SPECS.start.placeable).toBe(false);
    expect(Object.values(NODE_SPECS).filter((spec) => spec.placeable).every((spec) => spec.group !== null)).toBe(true);
    expect(Object.values(NODE_SPECS).filter((spec) => spec.group === 'Control' && spec.placeable).map((spec) => spec.type))
      .toEqual(['if', 'for', 'forEach', 'wait', 'set', 'end']);
  });

  it('draws each node in its flowchart shape', () => {
    expect(NODE_SPECS.start.shape).toBe('terminal');
    expect(NODE_SPECS.end.shape).toBe('terminal');
    expect(NODE_SPECS.if.shape).toBe('decision');
    expect(NODE_SPECS.mqttIn.shape).toBe('input');
    expect(NODE_SPECS.for.shape).toBe('loop');
    expect(NODE_SPECS.forEach.shape).toBe('loop');
    expect(NODE_SPECS.publish.shape).toBe('step');
  });

  it('puts each port on its side, and names the ones that need a name', () => {
    expect(['in', 'next', 'out', 'no', 'done'].map((port) => sideOf(port))).toEqual(['left', 'top', 'right', 'bottom', 'bottom']);
    expect(portLabel('up')).toBe('already up');
    expect(portLabel('none')).toBe("wasn't up");
    expect(portLabel('yes')).toBe('yes');
  });

  it('knows which nodes are loops', () => {
    expect(isLoop('for')).toBe(true);
    expect(isLoop('forEach')).toBe(true);
    expect(isLoop('if')).toBe(false);
  });

  it('says what a type it does not know is, with no ports to wire', () => {
    const spec = specOf('every');
    expect(spec.group).toBeNull();
    expect(spec.placeable).toBe(false);
    expect(spec.ins).toEqual([]);
  });

  it("names a Clear alarm's alarm by its Raise alarm's name", () => {
    const flow = {
      id: 'f', name: 'F', enabled: false, variables: [], edges: [],
      nodes: [{ id: 'hot', type: 'alarmRaise', x: 0, y: 0, config: { name: 'Boiler too hot', level: 'warn' } }],
    };
    expect(NODE_SPECS.alarmClear.summary({ alarm: 'hot' }, flow)).toBe('closes Boiler too hot');
    expect(NODE_SPECS.alarmClear.summary({ alarm: '' }, flow)).toBe('no alarm picked');
  });

  it("says each node's settings in one short line", () => {
    const say = (type: keyof typeof NODE_SPECS, config: Record<string, unknown>) => NODE_SPECS[type].summary(config, nothing);

    expect(say('mqttIn', { filter: 'plant/+/temp' })).toBe('plant/+/temp');
    expect(say('if', { field: '$.temp', test: 'gt', value: '90' })).toBe('$.temp > 90');
    expect(say('if', { field: '', test: 'between', value: '10', value2: '20' })).toBe('payload between 10 and 20');
    expect(say('if', { field: '$.fault', test: 'exists' })).toBe('$.fault exists');
    expect(say('for', { times: '3', forever: false })).toBe('3 times');
    // A forever loop keeps the count it had, and says only what it does.
    expect(say('for', { times: '3', forever: true })).toBe('forever');
    expect(say('forEach', { array: 'var.sensors' })).toBe('each of var.sensors');
    expect(say('wait', { seconds: 2 })).toBe('2 s');
    expect(say('set', { variable: 'limit', value: '95' })).toBe('limit = 95');
    expect(say('set', { variable: '', value: '95' })).toBe('no variable picked');
    expect(say('publish', { topic: 'plant/{{topic[1]}}/cmd' })).toBe('plant/{{topic[1]}}/cmd');
    expect(say('alarmRaise', { name: 'Too hot', level: 'critical' })).toBe('critical · Too hot');
    // Written by hand with no level, or one the server does not know: it says "Pick a level", and
    // the node does not claim one.
    expect(say('alarmRaise', { name: 'Too hot' })).toBe('no level · Too hot');
    expect(say('alarmRaise', { name: 'Too hot', level: 'loud' })).toBe('no level · Too hot');
    expect(say('sound', { level: 'warn' })).toBe('warn tone');
    expect(say('notify', { text: '{{topic[1]}} is hot' })).toBe('{{topic[1]}} is hot');
    expect(say('webhook', { url: '' })).toBe('no address yet');
  });

  it("says what a node has done from the server's counters", () => {
    expect(NODE_SPECS.start.status(counted({ count: 1 }))).toBe('1 run');
    expect(NODE_SPECS.mqttIn.status(counted({ count: 412, outs: { out: 412 } }))).toBe('412 read');
    expect(NODE_SPECS.if.status(counted({ outs: { yes: 3, no: 409 } }))).toBe('yes 3 · no 409');
    expect(NODE_SPECS.for.status(counted({ outs: { body: 3, done: 1 } }))).toBe('3 turns');
    expect(NODE_SPECS.publish.status(counted({ outs: { sent: 12 }, errors: 2 }))).toBe('12 sent · 2 errors');
    expect(NODE_SPECS.alarmRaise.status(counted({ outs: { raised: 4 }, standing: [{ topic: 'a', firedAt: '', reason: '', count: 1 }] })))
      .toBe('1 up · 4 raised');
    // What a channel let go past its rate is said before the errors, as what the node did not do.
    expect(NODE_SPECS.notify.status(counted({ outs: { shown: 5, dropped: 2 }, errors: 1 }))).toBe('5 shown · 2 dropped · 1 error');
    expect(NODE_SPECS.end.status(counted({ count: 2 }))).toBe('2 ended');
  });

  it('knows its own names, and none of the ones it has given up', () => {
    expect(isNodeType('forEach')).toBe(true);
    expect(isNodeType('alarmRaise')).toBe(true);
    for (const gone of ['inject', 'every', 'repeat', 'alarm']) expect(isNodeType(gone)).toBe(false);
    expect(isNodeType('teleport')).toBe(false);
  });

  // The server keeps a flow a newer build wrote, whatever its nodes are, and hands it back.
  it("draws a type it does not know by that type's own name, and says what is wrong with it", () => {
    const spec = specOf('function');

    expect(spec).toMatchObject({ label: 'function', ins: [], outs: [], shape: 'step' });
    expect(spec.help).toMatch(/^This build does not know this kind of node\./);
    expect(spec.summary({ code: 'return msg;' }, nothing)).toBe('not known to this build');
    expect(spec.status(counted({ count: 2, errors: 1 }))).toBe('2 in · 1 error');
    expect(specOf('if')).toBe(NODE_SPECS.if);
  });
});
