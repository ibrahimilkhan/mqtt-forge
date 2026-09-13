import { describe, expect, it } from 'vitest';
import type { LogEntry } from '../stores/logStore';
import { TopicRing } from '../stores/topicRing';
import {
  arrivedBehind,
  behind,
  covers,
  discount,
  forgetFrozen,
  freeze,
  holdName,
  inRegion,
  nearestHold,
  outermost,
  paneState,
  reaches,
  regionOf,
  shownRuns,
  treeView,
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

let nextId = 1;

/** Arrivals filed a topic at a time, the way the log keeps them. */
const log = (...arrivals: Array<[topic: string, body: string]>) => {
  const byTopic = new Map<string, TopicRing>();
  for (const [topic, body] of arrivals) add(byTopic, topic, body);
  return byTopic;
};

const add = (byTopic: Map<string, TopicRing>, topic: string, body: string) => {
  let ring = byTopic.get(topic);
  if (!ring) {
    ring = new TopicRing({ maxItems: 100, maxBytes: Number.POSITIVE_INFINITY });
    byTopic.set(topic, ring);
  }
  const entry: LogEntry = { id: nextId++, kind: 'recv', at: new Date(0), topic, body };
  ring.push(entry);
};

const bodies = (runs: LogEntry[][]) => runs.map((run) => run.map((one) => `${one.topic}=${one.body}`));

describe('the runs a filter shows', () => {
  it('reads the live runs when no hold is near', () => {
    const byTopic = log(['sensors/temp', '21']);

    expect(bodies(shownRuns(byTopic, new Map(), 'sensors/#'))).toEqual([['sensors/temp=21']]);
  });

  // The report: / paused, the broker's row picked above it, and the log streamed on.
  it('shows held topics as they were taken and the rest as they are, above a held row', () => {
    const byTopic = log(['/hfp/bus', 'a1'], ['plant/kiln', '900']);
    const slash = freeze('/#', byTopic, emptyTree(), new Map())!;
    add(byTopic, '/hfp/bus', 'a2');
    add(byTopic, 'plant/kiln', '910');

    expect(bodies(shownRuns(byTopic, holdsOf(slash), '#'))).toEqual([
      ['/hfp/bus=a1'],
      ['plant/kiln=910', 'plant/kiln=900'],
    ]);
  });

  it('narrows a branch hold to the row picked under it', () => {
    const byTopic = log(['sensors/temp', '21'], ['sensors/humidity', '55']);
    const sensors = freeze('sensors/#', byTopic, emptyTree(), new Map())!;
    add(byTopic, 'sensors/temp', '22');

    expect(bodies(shownRuns(byTopic, holdsOf(sensors), 'sensors/temp/#'))).toEqual([
      ['sensors/temp=21'],
    ]);
  });

  it('leaves out a topic that arrived behind the hold', () => {
    const byTopic = log(['sensors/temp', '21']);
    const sensors = freeze('sensors/#', byTopic, emptyTree(), new Map())!;
    add(byTopic, 'sensors/pressure', '1013');

    expect(bodies(shownRuns(byTopic, holdsOf(sensors), '#'))).toEqual([['sensors/temp=21']]);
  });

  it('goes on showing what the hold froze after the log lets the topic go', () => {
    const byTopic = log(['sensors/temp', '21']);
    const sensors = freeze('sensors/#', byTopic, emptyTree(), new Map())!;
    byTopic.delete('sensors/temp');

    expect(bodies(shownRuns(byTopic, holdsOf(sensors), 'sensors/#'))).toEqual([
      ['sensors/temp=21'],
    ]);
  });

  it('counts what arrived behind each held topic, and only under the hold asked about', () => {
    const byTopic = log(['sensors/temp', '21'], ['plant/kiln', '900']);
    const sensors = freeze('sensors/#', byTopic, emptyTree(), new Map())!;
    const plant = freeze('plant/#', byTopic, emptyTree(), holdsOf(sensors))!;
    add(byTopic, 'sensors/temp', '22');
    add(byTopic, 'sensors/pressure', '1013');
    add(byTopic, 'plant/kiln', '910');
    const all = holdsOf(sensors, plant);

    expect(arrivedBehind(byTopic, all, '#')).toBe(3);
    expect(arrivedBehind(byTopic, all, 'sensors/#', sensors)).toBe(2);
    expect(arrivedBehind(byTopic, all, 'plant/#', plant)).toBe(1);
  });
});

describe('the tree the holds draw', () => {
  it('draws a held row as it was, and a row above it without what the hold keeps back', () => {
    const before = tree(['sensors/temp', '21'], ['sensors/humidity', '55']);
    // Read before the second applyMessages call: a node's own fields are frozen once captured,
    // but its parent keeps its children map and mutates it in place (see the Held doc comment
    // above), so asking `before` for this same path again afterwards would answer with the row
    // as it now stands rather than as it stood here.
    const beforeTemp = at(before, 'sensors/temp');
    const temp = freeze('sensors/temp/#', new Map(), before, new Map())!;
    const after = applyMessages(before, [{ topic: 'sensors/temp', payload: '99' }], 2000);
    const view = treeView(holdsOf(temp), after);

    expect(view.row('sensors/temp', at(after, 'sensors/temp'))).toEqual({
      node: beforeTemp,
      held: true,
    });
    expect(view.row('sensors', at(after, 'sensors'))!.node.subMessages).toBe(2);
    expect(view.root.subMessages).toBe(2);
  });

  it('takes nested holds off the rows above once, not once each', () => {
    const before = tree(['plant/sensors/temp', '21'], ['plant/sensors/humidity', '55']);
    const temp = freeze('plant/sensors/temp/#', new Map(), before, new Map())!;
    const sensors = freeze('plant/sensors/#', new Map(), before, holdsOf(temp))!;
    const after = applyMessages(before, [{ topic: 'plant/sensors/temp', payload: '99' }], 2000);
    const view = treeView(holdsOf(temp, sensors), after);

    expect(view.row('plant', at(after, 'plant'))!.node.subMessages).toBe(2);
    expect(view.root.subMessages).toBe(2);
  });

  it('keeps a row that arrived behind the hold off screen', () => {
    const before = tree(['sensors/temp', '21']);
    const sensors = freeze('sensors/#', new Map(), before, new Map())!;
    const after = applyMessages(before, [{ topic: 'sensors/pressure', payload: '1013' }], 2000);

    expect(
      treeView(holdsOf(sensors), after).row('sensors/pressure', at(after, 'sensors/pressure')),
    ).toBeNull();
  });

  it('draws the broker row from what # froze, and freezes $SYS with the rest', () => {
    const before = tree(['$SYS/broker/uptime', '10'], ['sensors/temp', '21']);
    const everything = freeze('#', new Map(), before, new Map())!;
    const after = applyMessages(before, [{ topic: 'sensors/temp', payload: '22' }], 2000);
    const view = treeView(holdsOf(everything), after);

    expect(view.root.subMessages).toBe(2);
    expect(view.row('$SYS', at(after, '$SYS'))).not.toBeNull();
    expect(view.row('$SYS/broker/uptime', at(after, '$SYS/broker/uptime'))!.held).toBe(true);
  });
});

describe('taking a hold', () => {
  it('freezes what is on screen, so a row under a paused branch does not jump', () => {
    const byTopic = log(['sensors/temp', '21']);
    const before = tree(['sensors/temp', '21']);
    const sensors = freeze('sensors/#', byTopic, before, new Map())!;
    add(byTopic, 'sensors/temp', '22');
    const after = applyMessages(before, [{ topic: 'sensors/temp', payload: '22' }], 2000);

    const temp = freeze('sensors/temp/#', byTopic, after, holdsOf(sensors))!;

    expect(bodies([...temp.runs.values()])).toEqual([['sensors/temp=21']]);
    expect(temp.nodes.get('sensors/temp')!.latestPayload).toBe('21');
  });

  it('keeps the broker row without what a hold under it was keeping back', () => {
    const byTopic = log(['sensors/temp', '21'], ['plant/kiln', '900']);
    const before = tree(['sensors/temp', '21'], ['plant/kiln', '900']);
    const sensors = freeze('sensors/#', byTopic, before, new Map())!;
    const after = applyMessages(before, [{ topic: 'sensors/temp', payload: '22' }], 2000);

    const everything = freeze('#', byTopic, after, holdsOf(sensors))!;

    expect(everything.root!.subMessages).toBe(2);
  });

  it('takes nothing for a filter no row selects', () => {
    expect(freeze('sensors/+/temp', new Map(), emptyTree(), new Map())).toBeNull();
  });
});

describe('taking topics out of a hold', () => {
  const froze = () => {
    const arrivals: Array<[string, string]> = [
      ['sensors/temp', '21'],
      ['sensors/temp', '22'],
      ['sensors/humidity', '55'],
    ];

    return freeze('sensors/#', log(...arrivals), tree(...arrivals), new Map())!;
  };

  it('drops a cleared topic and takes it off the frozen rows above it', () => {
    const sensors = forgetFrozen(froze(), (topic) => topic === 'sensors/temp', 'nothing')!;

    expect([...sensors.runs.keys()]).toEqual(['sensors/humidity']);
    expect(sensors.nodes.has('sensors/temp')).toBe(false);
    expect(sensors.nodes.get('sensors')).toMatchObject({ subMessages: 1, subTopics: 1 });
  });

  it('lets the hold go once nothing is left in it', () => {
    expect(forgetFrozen(froze(), (topic) => topic.startsWith('sensors'), 'nothing')).toBeNull();
  });

  it('hands back the very same hold when none of its topics answer', () => {
    const sensors = froze();

    expect(forgetFrozen(sensors, (topic) => topic.startsWith('plant'), 'nothing')).toBe(sensors);
  });

  it('keeps the newest of each run when the reader keeps the newest', () => {
    const sensors = forgetFrozen(froze(), (topic) => topic === 'sensors/temp', 'the newest')!;

    expect(bodies([sensors.runs.get('sensors/temp')!])).toEqual([['sensors/temp=22']]);
    expect(sensors.nodes.get('sensors')!.subMessages).toBe(3);
  });

  it('prunes the broker row # froze, $SYS included', () => {
    const arrivals: Array<[string, string]> = [
      ['$SYS/broker/uptime', '10'],
      ['sensors/temp', '21'],
    ];
    const everything = freeze('#', log(...arrivals), tree(...arrivals), new Map())!;

    const left = forgetFrozen(everything, (topic) => topic.startsWith('$SYS'), 'nothing')!;

    expect(left.root!.subTopics).toBe(1);
    expect(left.nodes.has('$SYS')).toBe(false);
    expect(forgetFrozen(left, () => true, 'nothing')).toBeNull();
  });

  it('prunes a region standing on the empty first level', () => {
    const arrivals: Array<[string, string]> = [
      ['/hfp/bus/1', 'a'],
      ['/hfp/bus/2', 'b'],
    ];
    const slash = freeze('/#', log(...arrivals), tree(...arrivals), new Map())!;

    const left = forgetFrozen(slash, (topic) => topic === '/hfp/bus/1', 'nothing')!;

    expect(left.nodes.get('')!.subTopics).toBe(1);
    expect(left.nodes.has('/hfp/bus/1')).toBe(false);
    expect(left.nodes.has('/hfp/bus/2')).toBe(true);
  });
});
