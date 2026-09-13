import { describe, expect, it } from 'vitest';
import {
  behind,
  covers,
  discount,
  holdName,
  inRegion,
  nearestHold,
  outermost,
  paneState,
  reaches,
  regionOf,
  type Held,
  type Holds,
} from './holds';
import { applyMessages, emptyTree, nodeAt, type TopicNode } from './topicTree';

const tree = (...topics: Array<[topic: string, payload?: string]>) =>
  applyMessages(
    emptyTree(),
    topics.map(([topic, payload = '1']) => ({ topic, payload })),
    1000,
  );

const at = (root: TopicNode, path: string) => nodeAt(root, path)!;

/** A hold with nothing frozen in it yet, for the questions that only ask where it stands. */
const held = (filter: string, overrides: Partial<Held> = {}): Held => ({
  filter,
  path: regionOf(filter) as string | null,
  runs: new Map(),
  nodes: new Map(),
  root: null,
  ...overrides,
});

const holdsOf = (...all: Held[]): Holds => new Map(all.map((one) => [one.filter, one]));

describe('the region a hold stands on', () => {
  it('is everything for #, a row for its own filter, and nothing for a filter no row selects', () => {
    expect(regionOf('#')).toBeNull();
    expect(regionOf('sensors/#')).toBe('sensors');
    expect(regionOf('/#')).toBe('');
    expect(regionOf('sensors/+/temp')).toBeUndefined();
    expect(regionOf('sensors/temp')).toBeUndefined();
  });

  it('holds a path and what hangs under it, and nothing that only shares its start', () => {
    const sensors = held('sensors/#');

    expect(inRegion(sensors, 'sensors')).toBe(true);
    expect(inRegion(sensors, 'sensors/temp')).toBe(true);
    expect(inRegion(sensors, 'sensorsx')).toBe(false);
    expect(inRegion(held('#'), '$SYS/broker')).toBe(true);
    expect(inRegion(held('/#'), '/hfp/v2')).toBe(true);
    expect(inRegion(held('/#'), 'plant')).toBe(false);
  });
});

describe('which hold draws a path', () => {
  it('is the deepest one, whichever was taken first', () => {
    const everything = held('#');
    const slash = held('/#');

    expect(nearestHold([everything, slash], '/hfp')).toBe(slash);
    expect(nearestHold([slash, everything], '/hfp')).toBe(slash);
    expect(nearestHold([slash], 'plant')).toBeNull();
  });

  it('counts only the holds no other hold contains as outermost', () => {
    const sensors = held('sensors/#');
    const temp = held('sensors/temp/#');
    const plant = held('plant/#');
    const everything = held('#');

    expect(outermost([temp, sensors, plant])).toEqual([sensors, plant]);
    expect(outermost([everything, sensors])).toEqual([everything]);
  });
});

describe('what a hold has kept back', () => {
  it('is the growth of the live row over the frozen one', () => {
    const before = tree(['sensors/temp'], ['sensors/humidity']);
    const sensors = held('sensors/#', { nodes: new Map([['sensors', at(before, 'sensors')]]) });
    const after = applyMessages(
      before,
      [
        { topic: 'sensors/temp', payload: '2' },
        { topic: 'sensors/pressure', payload: '3' },
      ],
      2000,
    );

    expect(behind(sensors, after)).toEqual({ messages: 2, topics: 1 });
  });

  it('is nothing once the row has gone from the live tree', () => {
    const before = tree(['sensors/temp']);
    const sensors = held('sensors/#', { nodes: new Map([['sensors', at(before, 'sensors')]]) });

    expect(behind(sensors, emptyTree())).toEqual({ messages: 0, topics: 0 });
  });

  it('reads the broker row for #', () => {
    const before = tree(['a']);
    const everything = held('#', { root: before });
    const after = applyMessages(before, [{ topic: 'b', payload: '1' }], 2000);

    expect(behind(everything, after)).toEqual({ messages: 1, topics: 1 });
  });

  it('takes it out of a row, and hands the row back untouched when there is nothing to take', () => {
    const row = at(tree(['sensors/temp'], ['sensors/humidity']), 'sensors');

    expect(discount(row, { messages: 1, topics: 1 })).toMatchObject({ subMessages: 1, subTopics: 1 });
    expect(discount(row, { messages: 0, topics: 0 })).toBe(row);
  });
});

describe('what a filter and a hold share', () => {
  it('reaches a region any topic the filter shows lies in', () => {
    expect(reaches('#', held('sensors/#'))).toBe(true);
    expect(reaches('sensors/#', held('sensors/temp/#'))).toBe(true);
    expect(reaches('sensors/temp/#', held('sensors/#'))).toBe(true);
    expect(reaches('sensors/+/temp', held('sensors/room/#'))).toBe(true);
    expect(reaches('plant/#', held('sensors/#'))).toBe(false);
    expect(reaches('a/b', held('a/b/c/#'))).toBe(false);
    expect(reaches('+/broker', held('$SYS/#'))).toBe(false);
  });

  it('covers a filter only when every topic it shows lies in the region', () => {
    expect(covers(held('sensors/#'), 'sensors/temp/#')).toBe(true);
    expect(covers(held('sensors/temp/#'), 'sensors/#')).toBe(false);
    expect(covers(held('/#'), '#')).toBe(false);
    expect(covers(held('#'), '#')).toBe(true);
    expect(covers(held('a/#'), 'a/+/c')).toBe(true);
    expect(covers(held('a/#'), '+/b')).toBe(false);
  });

  it('describes a pane as held, touched or live', () => {
    const sensors = held('sensors/#');
    const all = holdsOf(sensors);

    expect(paneState(all, 'sensors/#')).toEqual({ own: sensors, over: sensors, touched: true });
    expect(paneState(all, 'sensors/temp/#')).toEqual({ own: null, over: sensors, touched: true });
    expect(paneState(all, '#')).toEqual({ own: null, over: null, touched: true });
    expect(paneState(all, 'plant/#')).toEqual({ own: null, over: null, touched: false });
  });

  it('names a hold the way a reader would', () => {
    expect(holdName(held('#'), 'mqtt.hsl.fi:8883')).toBe('mqtt.hsl.fi:8883');
    expect(holdName(held('/#'), 'x')).toBe('/');
    expect(holdName(held('plant/boiler/#'), 'x')).toBe('plant/boiler');
  });
});
