import { describe, expect, it, vi } from 'vitest';
import type { FlowDto, FlowNodeDto, FlowNodeType } from '../../types/api';
import {
  addNode,
  bodyOf,
  canConnect,
  connect,
  emptyFlow,
  fingerprint,
  freeSpot,
  GAP,
  insertAfter,
  insertOnWire,
  moveNodes,
  newId,
  nextName,
  noReturn,
  placeAfter,
  placesInView,
  problemsOf,
  removeEdges,
  removeNodes,
  ROW,
  sameFlow,
  setConfig,
  standingOf,
  unreached,
  unwiredOuts,
  withDrafts,
  type Wire,
} from './flowDocument';
import * as backWires from './backWires';
import { exampleFlows } from './examples';
import { DECISION_HEIGHT, DECISION_WIDTH, MEASURE, NODE_WIDTH, STEP_HEIGHT } from './FlowCanvas';
import { NODE_SPECS, sideOf } from './nodeTypes';
import { clicked, freshFlow, named, overlapsIn, routedIn, wrongWith } from './wireTestbed';

/**
 * Start → Wait → Set → End, under a flow id of its own each time, as a flow made on the page has:
 * the flow the cases about anything but its wiring change.
 */
const chain = (): FlowDto => ({
  id: newId('f'),
  name: 'Chain',
  enabled: true,
  variables: [{ name: 'limit', value: '90' }],
  nodes: [
    { id: 'a', type: 'start', x: 0, y: 0, config: {} },
    { id: 'b', type: 'wait', x: 200, y: 0, config: { seconds: '1' } },
    { id: 'c', type: 'set', x: 400, y: 0, config: { variable: 'limit', value: '95' } },
    { id: 'd', type: 'end', x: 600, y: 0, config: {} },
  ],
  edges: [
    { id: 'e1', from: 'a', fromPort: 'out', to: 'b', toPort: 'in' },
    { id: 'e2', from: 'b', fromPort: 'out', to: 'c', toPort: 'in' },
    { id: 'e3', from: 'c', fromPort: 'out', to: 'd', toPort: 'in' },
  ],
});

const at = { x: 0, y: 0 };

/** Start → a → End, where a is any node with one way in and one way out. */
const line = (type: FlowNodeType = 'debug'): FlowDto => ({
  id: 'f', name: 'F', enabled: false, variables: [],
  nodes: [
    { id: 'start', type: 'start', x: 0, y: 0, config: {} },
    { id: 'a', type, x: 200, y: 0, config: {} },
    { id: 'end', type: 'end', x: 400, y: 0, config: {} },
  ],
  edges: [
    { id: 'e1', from: 'start', fromPort: 'out', to: 'a', toPort: 'in' },
    { id: 'e2', from: 'a', fromPort: 'out', to: 'end', toPort: 'in' },
  ],
});

const wires = (flow: FlowDto) => flow.edges.map((edge) => `${edge.from}.${edge.fromPort}>${edge.to}.${edge.toPort}`).sort();

/** A wire written as `wires` prints one: `from.port>to.port`. */
const wire = (text: string): Wire => {
  const [from, fromPort, to, toPort] = text.split(/[.>]/);
  return { from, fromPort, to, toPort };
};

/** A flow of the nodes named, each of the type given, wired as the lines say. */
const drawing = (nodes: Record<string, FlowNodeType>, ...wired: string[]): FlowDto => ({
  id: 'f', name: 'F', enabled: false, variables: [],
  nodes: Object.entries(nodes).map(([id, type], index) => ({ id, type, x: index * 200, y: 0, config: {} })),
  edges: wired.map((text, index) => ({ id: `w${index + 1}`, ...wire(text) })),
});

/** Start → For l, whose body is one Publish wired back to l's next, and whose done ends the run. */
const looped = () =>
  drawing({ start: 'start', l: 'for', p: 'publish', end: 'end' }, 'start.out>l.in', 'l.body>p.in', 'p.out>l.next', 'l.done>end.in');

describe('flow document', () => {
  it('makes ids the server accepts', () => {
    for (let i = 0; i < 50; i++) expect(newId('n')).toMatch(/^n[a-z0-9]{8}$/);
  });

  it('names a new flow after the ones there are', () => {
    expect(nextName([])).toBe('Flow 1');
    expect(nextName([emptyFlow('Flow 1'), emptyFlow('Boiler watch')])).toBe('Flow 2');
  });

  // Where a node is dropped, or where the palette puts one free of the wires; the canvas marks its
  // way out until it is wired.
  it("adds a node with its type's defaults, where it was dropped, and wires it to nothing", () => {
    const before = emptyFlow('A');
    const flow = addNode(before, 'publish', { x: 120, y: 80 }, 'p1');

    expect(flow.nodes.at(-1)).toEqual({ id: 'p1', type: 'publish', x: 120, y: 80, config: NODE_SPECS.publish.defaults() });
    expect(flow.edges).toBe(before.edges);
  });

  it('moves nodes and rounds where they land', () => {
    const flow = moveNodes(chain(), { a: { x: 10.4, y: 20.6 } });

    expect(flow.nodes[0]).toMatchObject({ x: 10, y: 21 });
  });

  it('removes wires by id', () => {
    expect(removeEdges(chain(), ['e1']).edges.map((edge) => edge.id)).toEqual(['e2', 'e3']);
  });

  it('refuses a wire that would go round in a circle, back into its own node, or from or to a port that is not there', () => {
    const flow = line();
    const longer = chain();

    // Set back to Wait, which leads to Set: a circle through two nodes, with no loop to count its turns.
    expect(canConnect(longer, { from: 'c', fromPort: 'out', to: 'b', toPort: 'in' })).toBe(false);
    expect(connect(longer, { from: 'c', fromPort: 'out', to: 'b', toPort: 'in' })).toBe(longer);
    expect(canConnect(flow, { from: 'a', fromPort: 'out', to: 'a', toPort: 'in' })).toBe(false);
    expect(canConnect(flow, { from: 'end', fromPort: 'out', to: 'a', toPort: 'in' })).toBe(false);
    expect(canConnect(flow, { from: 'a', fromPort: 'yes', to: 'end', toPort: 'in' })).toBe(false);
    // Nothing goes into the Start: every run begins there.
    expect(canConnect(flow, { from: 'a', fromPort: 'out', to: 'start', toPort: 'in' })).toBe(false);
    expect(canConnect(flow, { from: 'a', fromPort: 'out', to: 'end', toPort: 'in' })).toBe(true);

    expect(connect(flow, { from: 'a', fromPort: 'out', to: 'a', toPort: 'in' })).toBe(flow);
  });

  // The server refuses every wire to or from a node it does not know, so the canvas does too; and
  // a node of a type written by a newer build must not be the end of the page.
  it('refuses a wire to or from a node of a type this build does not know', () => {
    const flow: FlowDto = { ...chain(), nodes: [...chain().nodes, { id: 'fn', type: 'function', x: 600, y: 0, config: {} }] };

    expect(canConnect(flow, { from: 'c', fromPort: 'out', to: 'fn', toPort: 'in' })).toBe(false);
    expect(canConnect(flow, { from: 'fn', fromPort: 'out', to: 'b', toPort: 'in' })).toBe(false);
  });

  it('replaces a node\'s settings and nothing else', () => {
    const before = chain();
    const flow = setConfig(before, 'c', { variable: 'limit', value: '80' });

    expect(flow.nodes[2].config).toEqual({ variable: 'limit', value: '80' });
    expect(flow.nodes[0]).toBe(before.nodes[0]);
  });

  it('calls two flows the same when only the order of keys in a setting differs', () => {
    // One chain, not two: two independent chain() calls would also differ in the flow's own
    // random id, which is not the order-of-keys difference this test is about.
    const base = chain();
    const a = setConfig(base, 'c', { variable: 'limit', value: '80' });
    const b = setConfig(base, 'c', { value: '80', variable: 'limit' });

    expect(sameFlow(a, b)).toBe(true);
    expect(sameFlow(a, moveNodes(a, { a: { x: 1, y: 1 } }))).toBe(false);
  });

  // A flow is never changed in place — every edit makes a new one — so what was worked out about
  // one flow object stays true of it. The page asks about every draft on every drag frame.
  it('works out whether two flows are the same once, however often it is asked', () => {
    const deployed = chain();
    const draft = { ...deployed, name: 'Chain 2' };
    const stringify = vi.spyOn(JSON, 'stringify');

    const first = sameFlow(draft, deployed);
    const made = stringify.mock.calls.length;
    const again = [sameFlow(draft, deployed), sameFlow(draft, deployed), sameFlow(deployed, deployed)];
    const madeAgain = stringify.mock.calls.length - made;
    stringify.mockRestore();

    expect(first).toBe(false);
    expect(again).toEqual([false, false, true]);
    expect(madeAgain).toBe(0);
  });

  // Activate and Deactivate switch a flow on and off; nothing on the canvas does. So a flow switched
  // on or off — here or on another console — leaves every draft of it standing as it stood.
  it('takes a flow switched on or off for the same flow, since a draft never changes that', () => {
    const flow = emptyFlow('Flow 1');

    expect(sameFlow(flow, { ...flow, enabled: true })).toBe(true);
    expect(fingerprint(flow)).toBe(fingerprint({ ...flow, enabled: true }));
  });

  it('lays drafts over the deployed flows, deployed order first and new drafts after', () => {
    const deployed = [emptyFlow('One'), emptyFlow('Two')];
    const renamed = { ...deployed[1], name: 'Two, renamed' };
    const fresh = emptyFlow('Three');

    const shown = withDrafts(deployed, { [renamed.id]: renamed, [fresh.id]: fresh });

    expect(shown.map((flow) => flow.name)).toEqual(['One', 'Two, renamed', 'Three']);
  });

  // The server sends no version of a flow, so a draft remembers the copy it was started from by a
  // fingerprint of that copy.
  it('fingerprints a flow by what it says, not by how its keys were ordered or which object it is', () => {
    const base = chain();
    const same = setConfig(base, 'c', { value: '80', variable: 'limit' });
    const reordered = setConfig(base, 'c', { variable: 'limit', value: '80' });

    expect(fingerprint(same)).toBe(fingerprint(reordered));
    expect(fingerprint(same)).toBe(fingerprint(JSON.parse(JSON.stringify(same)) as FlowDto));
    expect(fingerprint(moveNodes(same, { a: { x: 8, y: 0 } }))).not.toBe(fingerprint(same));
    expect(fingerprint({ ...same, name: 'Chain 2' })).not.toBe(fingerprint(same));
    expect(fingerprint(same)).toMatch(/^[0-9a-z]{1,12}$/);
  });

  /**
   * A draft against the server's copy of its flow. `v1` is the copy a draft was started from; the
   * server may since have moved on to `v2`, or deleted the flow.
   */
  describe('how a draft stands', () => {
    const v1 = chain();
    const v2 = { ...v1, name: 'Chain, from another console' };
    const edited = { ...v1, name: 'Chain, edited here' };

    it('holds nothing of the reader\'s when it says what the server has', () => {
      expect(standingOf({ ...v1 }, fingerprint(v1), v1)).toBe('nothing');
      expect(standingOf({ ...v2 }, fingerprint(v1), v2)).toBe('nothing');
    });

    // Switched off on another console since, the copy is still the one the draft was started from.
    it('holds nothing of the reader\'s when it differs from the server\'s copy only in being switched on or off', () => {
      expect(standingOf({ ...v1, enabled: false }, fingerprint(v1), v1)).toBe('nothing');
    });

    it('is still an edit of the server\'s copy once another console has switched that copy off', () => {
      expect(standingOf(edited, fingerprint(v1), { ...v1, enabled: false })).toBe('changed');
    });

    it('is a change to save when it is an edit of the copy the server has, or of a flow the server never had', () => {
      expect(standingOf(edited, fingerprint(v1), v1)).toBe('changed');
      expect(standingOf(edited, null, undefined)).toBe('changed');
    });

    it('holds nothing of the reader\'s when it is the copy it started from, and the server has moved on or let it go', () => {
      expect(standingOf({ ...v1 }, fingerprint(v1), v2)).toBe('nothing');
      expect(standingOf({ ...v1 }, fingerprint(v1), undefined)).toBe('nothing');
    });

    it('is overtaken when it is an edit of a copy the server has since replaced or deleted', () => {
      expect(standingOf(edited, fingerprint(v1), v2)).toBe('overtaken');
      expect(standingOf(edited, fingerprint(v1), undefined)).toBe('overtaken');
      expect(standingOf(edited, null, v1)).toBe('overtaken');
    });

  });

  it('files the server\'s problems by flow and key', () => {
    expect(problemsOf([
      { flowId: 'a', key: 'node:n1', message: 'Pick a test.' },
      { flowId: 'a', key: 'node:n1', message: 'And another.' },
      { flowId: 'b', key: 'flow', message: 'Name the flow.' },
    ])).toEqual({
      a: { 'node:n1': ['Pick a test.', 'And another.'] },
      b: { flow: ['Name the flow.'] },
    });
  });

  // A loop's body wires back into its own next, the one wire that may go back: drawn again one wire
  // at a time, as a reader would draw it, every one of them is one the canvas lets land.
  it('builds two example flows whose every wire the canvas would allow', () => {
    const [simulator, watch] = exampleFlows();

    expect(simulator.name).toBe('Boiler simulator');
    expect(watch.name).toBe('Boiler watch');

    for (const flow of [simulator, watch]) {
      const bare = { ...flow, edges: [] as FlowDto['edges'] };
      let rebuilt = bare;
      for (const edge of flow.edges) {
        expect(canConnect(rebuilt, edge)).toBe(true);
        rebuilt = connect(rebuilt, edge, edge.id);
      }
    }
  });

  // The palette's click puts a node in the middle of the view, or beside or below what is already
  // there. Where the flow's nodes stand decides it, not how many clicks came before.
  describe('where a node the palette adds goes', () => {
    const box = { width: 188, height: 80 };
    const gap = 24;
    /** Every node a step's box. */
    const steps = () => box;
    /** An If's diamond in a box of its own, every other node a step's: as the page reckons them. */
    const shapes = (type: string) => (type === 'if' ? { width: 252, height: 128 } : box);
    /** A flow with no nodes at all, not even the Start and the End a new flow has: an empty canvas. */
    const bare = (): FlowDto => ({ ...emptyFlow('Placed'), nodes: [], edges: [] });
    const at = (x: number, y: number): FlowDto => addNode(bare(), 'debug', { x, y }, 'there');

    it('goes where it was asked to when nothing is there', () => {
      expect(freeSpot(bare(), { x: 100, y: 50 }, 'debug', steps, 3, gap)).toEqual({ x: 100, y: 50 });
    });

    it('steps across past a node in the way, and a gap beyond it', () => {
      expect(freeSpot(at(100, 50), { x: 100, y: 50 }, 'debug', steps, 3, gap)).toEqual({ x: 100 + 188 + 24, y: 50 });
    });

    it('goes down a row once the row is full', () => {
      let flow = at(100, 50);
      flow = addNode(flow, 'debug', { x: 312, y: 50 }, 'beside');

      expect(freeSpot(flow, { x: 100, y: 50 }, 'debug', steps, 2, gap)).toEqual({ x: 100, y: 50 + 80 + 24 });
    });

    // A node dragged half across the place the click would have used is in the way all the same.
    it('steps round a node that only covers part of a place', () => {
      expect(freeSpot(at(200, 90), { x: 100, y: 50 }, 'debug', steps, 1, gap)).toEqual({ x: 100, y: 50 + 2 * (80 + 24) });
    });

    // An If's diamond reaches 48 further down than a step's box: a step put a row under it, reckoned
    // as a step, stood on its lower half.
    it('measures each node in the way by its own box', () => {
      const branching = addNode(bare(), 'if', { x: 100, y: 50 }, 'test');

      expect(freeSpot(branching, { x: 100, y: 50 }, 'debug', shapes, 1, gap)).toEqual({ x: 100, y: 50 + 2 * (80 + 24) });
      expect(freeSpot(branching, { x: 100, y: 50 }, 'debug', steps, 1, gap)).toEqual({ x: 100, y: 50 + 80 + 24 });
    });

    it('steps the node it puts down by its own box', () => {
      expect(freeSpot(at(100, 50), { x: 100, y: 50 }, 'if', shapes, 3, gap)).toEqual({ x: 100 + 252 + 24, y: 50 });
      expect(freeSpot(at(100, 50), { x: 100, y: 50 }, 'if', shapes, 1, gap)).toEqual({ x: 100, y: 50 + 128 + 24 });
    });

    // The middle of the view is seldom on a whole pixel, and a node is kept on one. Reckoned from
    // the start as given, the node just put there stood half a pixel into the next place along,
    // and every add passed over a place that was free.
    it('reckons its places from where a node put at the start is kept', () => {
      const start = { x: 100.6, y: 50.6 };
      let flow = bare();
      for (const id of ['a', 'b', 'c', 'd']) flow = addNode(flow, 'debug', freeSpot(flow, start, 'debug', steps, 3, gap), id);

      expect(flow.nodes.map(({ x, y }) => [x, y])).toEqual([[101, 51], [313, 51], [525, 51], [101, 155]]);
    });

    // A Publish put free has its way out wanting a wire, and says so beside it: 56 left of the End,
    // level with its way in, that wire me stood right in front of the End's way in.
    it('keeps the names of the node it puts down out of the way of the ports round it', () => {
      const ending = addNode(bare(), 'end', { x: 644, y: 288 }, 'end');
      const start = { x: 375, y: 302 };
      const spot = freeSpot(ending, start, 'publish', MEASURE.boxOf, 1, MEASURE.room, MEASURE);
      const put: FlowNodeDto = { id: 'put', type: 'publish', x: spot.x, y: spot.y, config: {} };

      expect(freeSpot(ending, start, 'publish', MEASURE.boxOf, 1, MEASURE.room)).toEqual(start);
      expect(MEASURE.crowds(ending, { ...put, ...start }, ending.nodes[0], MEASURE.room)).toBe(true);
      expect(spot).not.toEqual(start);
      expect(MEASURE.crowds(ending, put, ending.nodes[0], MEASURE.room)).toBe(false);
    });

    // As many to a row as fit between the middle of the view and its right edge. The page in jsdom
    // has a canvas of no width and only ever gets one, so the sum is pinned here.
    it('puts as many to a row as the view has room for, from a node centred in it', () => {
      // A view from 0 to its width, at a zoom of 1.
      const view = (width: number) => placesInView({ x: width / 2, y: 300 }, width, box, gap);

      expect(view(800)).toEqual({ start: { x: 400 - 94, y: 300 - 40 }, across: 2 });
      // Two need 188 + 24 + 188 from the first one's left edge, which is 94 left of the middle.
      expect(view(611).across).toBe(1);
      expect(view(612).across).toBe(2);
      expect(view(1035).across).toBe(2);
      expect(view(1036).across).toBe(3);
    });
  });
});

describe('a flowchart stays whole while it is built', () => {
  it('starts as a Start wired to an End, switched off, with no variables', () => {
    const flow = emptyFlow('Flow 1');

    expect(flow.nodes.map((node) => node.type)).toEqual(['start', 'end']);
    expect(flow.enabled).toBe(false);
    expect(flow.variables).toEqual([]);
    expect(wires(flow)).toEqual([`start.out>${flow.nodes[1].id}.in`]);
    expect(unwiredOuts(flow).size).toBe(0);
    expect(unreached(flow).size).toBe(0);
  });

  it('puts a node on a wire, and sends its way out where the wire went', () => {
    const flow = insertOnWire(line(), 'e2', 'publish', at, 'p');

    expect(wires(flow)).toEqual(['a.out>p.in', 'p.out>end.in', 'start.out>a.in']);
  });

  it("sends both of a decision's ways out where the wire went", () => {
    expect(wires(insertOnWire(line(), 'e2', 'if', at, 'q'))).toEqual(['a.out>q.in', 'q.no>end.in', 'q.yes>end.in', 'start.out>a.in']);
  });

  it('gives a loop put on a wire an empty body and sends its done where the wire went', () => {
    expect(wires(insertOnWire(line(), 'e2', 'for', at, 'l'))).toEqual(['a.out>l.in', 'l.body>l.next', 'l.done>end.in', 'start.out>a.in']);
  });

  it('puts a node after one with a single way out, on the wire that way out has', () => {
    expect(wires(insertAfter(line(), 'a', 'wait', at, 'w')!)).toEqual(['a.out>w.in', 'start.out>a.in', 'w.out>end.in']);
  });

  // With no wire to follow, the new node is wired from the node it follows and its ways out have
  // nowhere to go yet — but for a loop's body, which goes back to its own next wherever the loop is
  // put: a loop is drawn with an empty body, and one nothing came back to would be refused.
  it('puts a node after one whose way out has no wire, a loop with its empty body', () => {
    const open: FlowDto = { ...line(), edges: line().edges.filter((edge) => edge.id !== 'e2') };
    const step = insertAfter(open, 'a', 'wait', at, 'w')!;
    const loop = insertAfter(open, 'a', 'for', at, 'l')!;

    expect(wires(step)).toEqual(['a.out>w.in', 'start.out>a.in']);
    expect(unwiredOuts(step)).toEqual(new Set(['w:out']));
    expect(wires(loop)).toEqual(['a.out>l.in', 'l.body>l.next', 'start.out>a.in']);
    expect(unwiredOuts(loop)).toEqual(new Set(['l:done']));
    expect(noReturn(loop)).toEqual(new Set());
  });

  // Dropped on the canvas, or put by the palette away from the wires, a loop has its empty body all
  // the same: one put down with nothing coming back to it would be refused.
  it('gives a loop put down away from the wires its empty body', () => {
    const flow = addNode(emptyFlow('A'), 'for', at, 'l');

    expect(wires(flow)).toContain('l.body>l.next');
    expect(noReturn(flow)).toEqual(new Set());
  });

  it('cannot put a node after one with two ways out', () => {
    const decision = insertOnWire(line(), 'e2', 'if', at, 'q');
    expect(insertAfter(decision, 'q', 'debug', at, 'd')).toBeNull();
  });

  it('joins what came before a step to what came after when the step is taken out', () => {
    const flow = removeNodes(line(), ['a']);

    expect(flow.nodes.map((node) => node.id)).toEqual(['start', 'end']);
    expect(wires(flow)).toEqual(['start.out>end.in']);
  });

  it('never takes the Start out', () => {
    expect(removeNodes(line(), ['start']).nodes.map((node) => node.id)).toEqual(['start', 'a', 'end']);
  });

  // Joined over, the last step's way in — the loop's body — goes where its way out went: the loop's
  // own next. The loop is left as it was put down, and not as one nothing comes back to.
  it("leaves a loop an empty body when the last step of the body is taken out", () => {
    const flow = removeNodes(looped(), ['p']);

    expect(wires(flow)).toEqual(['l.body>l.next', 'l.done>end.in', 'start.out>l.in']);
    expect(noReturn(flow)).toEqual(new Set());
  });

  // Each is joined over in the flow the one before it left, so the chain is whole whichever of
  // its steps is named first.
  it('joins over several steps of a chain taken out at once, in whatever order they are named', () => {
    const flow = chain();

    for (const ids of [['b', 'c'], ['c', 'b']]) {
      const left = removeNodes(flow, ids);
      expect(left.nodes.map((node) => node.id)).toEqual(['a', 'd']);
      expect(wires(left)).toEqual(['a.out>d.in']);
    }
  });

  // Which of a decision's two ways the run should have gone on by is the reader's to say: its wires
  // go with it, and the way into it is left unwired for the canvas to mark.
  it('drops the wires of a node with two ways out, and joins nothing over it', () => {
    const flow = removeNodes(
      drawing({ start: 'start', q: 'if', hot: 'end', cold: 'end' }, 'start.out>q.in', 'q.yes>hot.in', 'q.no>cold.in'),
      ['q'],
    );

    expect(wires(flow)).toEqual([]);
    expect(unwiredOuts(flow)).toEqual(new Set(['start:out']));
  });

  // A step wired back into itself is one only a hand-edited flows.json holds — the canvas and the
  // server both refuse the wire. Joined over, the wires into the step would end on the very step
  // that was taken out.
  it('drops the wires into a step whose way out goes back into it, and joins none of them to it', () => {
    const flow = removeNodes(drawing({ start: 'start', a: 'debug' }, 'start.out>a.in', 'a.out>a.in'), ['a']);

    expect(flow.nodes.map((node) => node.id)).toEqual(['start']);
    expect(wires(flow)).toEqual([]);
  });

  it("replaces a way out's wire with a new one, since a way out has one", () => {
    const flow = { ...line(), nodes: [...line().nodes, { id: 'b', type: 'end', x: 0, y: 200, config: {} }] };

    expect(wires(connect(flow, { from: 'a', fromPort: 'out', to: 'b', toPort: 'in' }, 'e3'))).toEqual(['a.out>b.in', 'start.out>a.in']);
  });

  // A wire dropped on the port it already goes to is no change; given a new id it would read as
  // one, and the page would offer to deploy a flow nobody changed.
  it('leaves the flow as it was when the wire drawn is the one the way out already has', () => {
    const flow = line();

    expect(connect(flow, wire('a.out>end.in'))).toBe(flow);
  });

  it("lets a body come back to its own loop's next, and nothing else go back", () => {
    const loop = insertOnWire(line(), 'e2', 'for', at, 'l');
    const filled = insertOnWire(loop, loop.edges.find((edge) => edge.fromPort === 'body')!.id, 'publish', at, 'p');

    expect(canConnect(filled, { from: 'p', fromPort: 'out', to: 'l', toPort: 'next' })).toBe(true);
    expect(canConnect(filled, { from: 'a', fromPort: 'out', to: 'l', toPort: 'next' })).toBe(false);
    expect(canConnect(filled, { from: 'p', fromPort: 'out', to: 'a', toPort: 'in' })).toBe(false);
    expect(bodyOf(filled, 'l')).toEqual(new Set(['p']));
  });

  it('names every way out that has no wire, and every node Start does not lead to', () => {
    const flow: FlowDto = {
      ...line(),
      nodes: [...line().nodes, { id: 'lonely', type: 'debug', x: 0, y: 300, config: {} }],
    };

    expect(unwiredOuts(flow)).toEqual(new Set(['lonely:out']));
    expect(unreached(flow)).toEqual(new Set(['lonely']));
  });

  // Every way out wired and every node reached, and still refused: a loop whose turn, once begun,
  // has no way to end. A loop is put down with its body wired to its own next, so it comes to this
  // when an End is put on that wire, or when its last wire back is drawn somewhere else.
  it('names every loop nothing comes back to', () => {
    const empty = insertOnWire(line(), 'e2', 'for', at, 'l');
    const body = empty.edges.find((edge) => edge.fromPort === 'body')!.id;
    const filled = insertOnWire(empty, body, 'publish', at, 'p');
    const ended = insertOnWire(empty, body, 'end', at, 'stop');
    const rewired = connect(filled, wire('p.out>end.in'));

    expect(noReturn(emptyFlow('A'))).toEqual(new Set());
    expect(noReturn(empty)).toEqual(new Set());
    expect(noReturn(filled)).toEqual(new Set());

    for (const flow of [ended, rewired]) {
      expect(unwiredOuts(flow)).toEqual(new Set());
      expect(unreached(flow)).toEqual(new Set());
      expect(noReturn(flow)).toEqual(new Set(['l']));
      // Asked on every frame of a drag, as the others are: worked out once for each flow.
      expect(noReturn(flow)).toBe(noReturn(flow));
    }
  });
});

/*
 * The server's rule for a wire into a loop's next: it is the loop's own return when it comes from a
 * step of the loop's body that neither the way in before the loop nor the loop's done also leads
 * to — or from the loop itself, when the body is empty. A run anywhere else would come to next with
 * no turn going.
 */
describe("only a loop's own body comes back to its next", () => {
  // p would be after the loop as well as in it: a run that came to p from done would go on to
  // next with no turn going, and the server would refuse p's wire back.
  it("refuses a wire from a loop's done into its body", () => {
    expect(canConnect(looped(), wire('l.done>p.in'))).toBe(false);
  });

  // Led to from before the loop too, p is somewhere a run gets to without the loop.
  it('refuses a wire into a body from before the loop', () => {
    const flow = drawing(
      { start: 'start', q: 'if', l: 'for', p: 'publish', end: 'end' },
      'start.out>q.in', 'q.yes>l.in', 'q.no>end.in', 'l.body>p.in', 'p.out>l.next', 'l.done>end.in',
    );

    expect(canConnect(flow, wire('q.no>p.in'))).toBe(false);
  });

  // A loop whose body breaks out of it has nothing coming back, and the wire from before it would be
  // the only one there: still not the loop's own.
  it("refuses a wire into next from before the loop when nothing else comes back to it", () => {
    const flow = drawing(
      { start: 'start', q: 'if', l: 'for', p: 'publish', end: 'end' },
      'start.out>q.in', 'q.yes>l.in', 'q.no>end.in', 'l.body>p.in', 'p.out>end.in', 'l.done>end.in',
    );

    expect(noReturn(flow)).toEqual(new Set(['l']));
    expect(canConnect(flow, wire('q.no>l.next'))).toBe(false);
  });

  // A break: a way out of the body that leaves the loop for what follows it. Nothing there comes
  // back to next, so no return is spoiled.
  it("lets a way out of the body go where the loop's done goes", () => {
    const flow = drawing(
      { start: 'start', l: 'for', q: 'if', a: 'debug', end: 'end' },
      'start.out>l.in', 'l.body>q.in', 'q.yes>l.next', 'q.no>l.next', 'l.done>a.in', 'a.out>end.in',
    );

    expect(canConnect(flow, wire('q.no>a.in'))).toBe(true);
  });

  // A turn of the inner loop that gives up on it goes on to the outer loop's next turn: q is in the
  // outer loop's body too, and neither before that loop nor after it.
  it("lets a step of a loop inside another come back to the outer loop's next", () => {
    const flow = drawing(
      { start: 'start', o: 'for', i: 'forEach', q: 'if', end: 'end' },
      'start.out>o.in', 'o.body>i.in', 'i.body>q.in', 'q.yes>i.next', 'q.no>i.next', 'i.done>o.next', 'o.done>end.in',
    );

    expect(canConnect(flow, wire('q.no>o.next'))).toBe(true);
  });

  // A loop put down away from the wires, its body wired back to its own next, is wired in like any
  // other node: an empty body is the loop's own however a run comes to the loop.
  it('lets a loop with an empty body be wired in from where it was put down', () => {
    const flow = drawing(
      { start: 'start', a: 'debug', end: 'end', l: 'for' },
      'start.out>a.in', 'a.out>end.in', 'l.body>l.next', 'l.done>end.in',
    );

    expect(canConnect(flow, wire('a.out>l.in'))).toBe(true);
  });

  it('still refuses a circle inside a body, and a step wired to itself', () => {
    const flow = drawing(
      { start: 'start', l: 'for', p: 'publish', w: 'wait', end: 'end' },
      'start.out>l.in', 'l.body>p.in', 'p.out>w.in', 'w.out>l.next', 'l.done>end.in',
    );

    expect(canConnect(flow, wire('w.out>p.in'))).toBe(false);
    expect(canConnect(flow, wire('p.out>p.in'))).toBe(false);
  });

  // flows.json, or a console of an older build, can hand the page a return the server refuses.
  // Testing the flow says so; it must not stop every other wire from being drawn — not even one
  // into the loop it belongs to, which leaves it no worse than it was.
  it('lets a wire be drawn elsewhere in a flow that already has a return the server refuses', () => {
    const flow = drawing(
      { start: 'start', q: 'if', l: 'for', p: 'publish', end: 'end', stop: 'end' },
      'start.out>q.in', 'q.yes>l.in', 'q.no>end.in', 'l.body>p.in', 'p.out>l.next', 'l.done>p.in',
    );

    expect(canConnect(flow, wire('q.no>stop.in'))).toBe(true);
    expect(canConnect(flow, wire('q.no>l.in'))).toBe(true);
  });

  // A step the wire before it no longer leads to is drawn faded, as one nothing leads to. Its wire
  // back is decided when something leads there again, and only the body may.
  it('lets a wire in a body be moved to a new step while the step it left still comes back, and that step be led to again from the body only', () => {
    const flow = drawing(
      { start: 'start', q: 'if', l: 'for', a: 'debug', x: 'wait', b: 'publish', end: 'end' },
      'start.out>q.in', 'q.yes>l.in', 'q.no>end.in', 'l.body>a.in', 'a.out>x.in', 'x.out>l.next', 'l.done>end.in',
    );
    const moved = connect(flow, wire('a.out>b.in'));

    expect(wires(moved)).toContain('a.out>b.in');
    expect(canConnect(moved, wire('b.out>x.in'))).toBe(true);
    expect(canConnect(moved, wire('q.no>x.in'))).toBe(false);
    expect(canConnect(moved, wire('l.done>x.in'))).toBe(false);
  });

  // A body can be drawn from its last step back: the step is faded until the body leads to it.
  it('lets a return be drawn from a step nothing leads to yet, and that step be led to from the body only', () => {
    const flow = drawing(
      { start: 'start', q: 'if', l: 'for', b: 'publish', end: 'end' },
      'start.out>q.in', 'q.yes>l.in', 'q.no>end.in', 'l.body>l.next', 'l.done>end.in',
    );
    const back = connect(flow, wire('b.out>l.next'));

    expect(wires(back)).toContain('b.out>l.next');
    expect(canConnect(back, wire('l.body>b.in'))).toBe(true);
    expect(canConnect(back, wire('q.no>b.in'))).toBe(false);
    expect(canConnect(back, wire('l.done>b.in'))).toBe(false);
  });
});

/*
 * A palette click puts a node after the one it follows (placeAfter), and moves along what is in the
 * way. In the way is what crowds the place by a wire's margin, and never the node it follows. At the
 * wider room a node put down free keeps, an If put on an If's no, 48 under the If, counted that If as
 * in its way and went three places along; and a row a reader laid 40 under a chain was in the way of a
 * node clicked into the chain, which went two rows down, or was pushed along with the chain.
 */
describe('where a palette click after a node puts it', () => {
  const wireOf = (flow: FlowDto, from: string, port: string) => flow.edges.find((edge) => edge.from === from && edge.fromPort === port)!.id;
  const nodeOf = (flow: FlowDto, id: string) => flow.nodes.find((node) => node.id === id)!;
  const click = (flow: FlowDto, pick: { node: string } | { wire: string }, type: FlowNodeType, id: string) => named(clicked(flow, pick, type, id));

  /** A chain from the Start to the End by hand, steps 284 apart, and a row of two Publishes laid 40 under it, wired one to the other. */
  const rows = (): FlowDto => ({
    id: 'rows', name: 'Rows', enabled: false, variables: [],
    nodes: [
      { id: 'start', type: 'start', x: 0, y: 0, config: {} },
      { id: 'a', type: 'debug', x: 284, y: 0, config: {} },
      { id: 'b', type: 'debug', x: 568, y: 0, config: {} },
      { id: 'c', type: 'debug', x: 852, y: 0, config: {} },
      { id: 'end', type: 'end', x: 1136, y: 0, config: {} },
      { id: 'x', type: 'publish', x: 600, y: 120, config: {} },
      { id: 'y', type: 'publish', x: 900, y: 120, config: {} },
    ],
    edges: [
      { id: 'e1', from: 'start', fromPort: 'out', to: 'a', toPort: 'in' },
      { id: 'e2', from: 'a', fromPort: 'out', to: 'b', toPort: 'in' },
      { id: 'e3', from: 'b', fromPort: 'out', to: 'c', toPort: 'in' },
      { id: 'e4', from: 'c', fromPort: 'out', to: 'end', toPort: 'in' },
      { id: 'e5', from: 'x', fromPort: 'out', to: 'y', toPort: 'in' },
    ],
  });

  it('puts an If on an If’s no under its foot, and an If on that one’s no under its own', () => {
    let flow = click(freshFlow(), { node: 'start' }, 'mqttIn', 'read');
    flow = click(flow, { node: 'read' }, 'if', 'one');
    const one = nodeOf(flow, 'one');

    flow = click(flow, { wire: wireOf(flow, 'one', 'no') }, 'if', 'two');
    // Its way in GAP/2 past the foot, its middle a row under the If's.
    expect(nodeOf(flow, 'two')).toMatchObject({ x: one.x + DECISION_WIDTH / 2 + GAP / 2, y: one.y + ROW });
    flow = click(flow, { wire: wireOf(flow, 'two', 'no') }, 'if', 'three');
    expect(nodeOf(flow, 'three')).toMatchObject({ x: one.x + DECISION_WIDTH + GAP, y: one.y + 2 * ROW });
    expect([...overlapsIn(flow), ...wrongWith(flow)]).toEqual([]);
  });

  it('puts an If on the watch’s If’s no under its foot, and moves the Clear alarm there along', () => {
    const watch = exampleFlows()[1];
    const test = nodeOf(watch, 'test');
    const cool = nodeOf(watch, 'cool');
    const flow = click(watch, { wire: wireOf(watch, 'test', 'no') }, 'if', 'check');

    expect(nodeOf(flow, 'check')).toMatchObject({ x: test.x + DECISION_WIDTH / 2 + GAP / 2, y: test.y + ROW });
    expect(nodeOf(flow, 'cool')).toMatchObject({ x: cool.x + DECISION_WIDTH + GAP, y: cool.y });
    expect([...overlapsIn(flow), ...wrongWith(flow)]).toEqual([]);
  });

  it('puts a node clicked into a chain on the chain’s row, past a row laid 40 under it, which stays', () => {
    const flow = click(rows(), { node: 'a' }, 'debug', 'say');

    expect(nodeOf(flow, 'say')).toMatchObject({ x: 568, y: 0 });
    expect(['b', 'c', 'end'].map((id) => nodeOf(flow, id).x)).toEqual([852, 1136, 1420]);
    expect(['x', 'y'].map((id) => nodeOf(flow, id))).toMatchObject([{ x: 600, y: 120 }, { x: 900, y: 120 }]);
    expect([...overlapsIn(flow), ...wrongWith(flow)]).toEqual([]);
  });

  // Two nodes may stand a wire's margin apart, but not with a port of either facing the other: its
  // wire turns along the other node, and the wires to that node come through the same gap. An If's no
  // came down 36 over a For each, where the loop's returns come down onto its next.
  it('counts a node a port faces nearer than the room a node put down free keeps as crowding it', () => {
    const flow = {
      ...rows(),
      nodes: [...rows().nodes, { id: 'test', type: 'if' as const, x: 1324, y: 92, config: {} }, { id: 'each', type: 'forEach' as const, x: 1351, y: 256, config: {} }],
    };
    const [a, x, test, each] = ['a', 'x', 'test', 'each'].map((id) => nodeOf(flow, id));

    expect(each.y - (test.y + DECISION_HEIGHT)).toBe(36);
    expect(MEASURE.crowds(flow, test, each, MEASURE.margin)).toBe(true);
    expect(MEASURE.crowds(flow, { ...test, y: each.y - DECISION_HEIGHT - 56 }, each, MEASURE.margin)).toBe(false);
    // A step 40 under a chain's step, with no port facing up or down: a margin apart is room enough.
    expect(MEASURE.crowds(flow, a, { ...x, x: a.x }, MEASURE.margin)).toBe(false);
  });

  // Whether one node crowds another is asked of every two a click weighs, each node against the place
  // and each node moved against each that stays: in a chain of two hundred, ten thousand of them.
  // Worked out again for every one, the names round both made a click there a hundred times as slow.
  it('works out the names round no node twice for a click, and only round nodes near what it puts down and moves', () => {
    const count = 200;
    const flow: FlowDto = {
      id: 'long', name: 'Long', enabled: false, variables: [],
      nodes: Array.from({ length: count }, (_, at) => ({
        id: `n${at}`,
        type: at === 0 ? 'start' : at === count - 1 ? 'end' : 'debug',
        x: at * (NODE_WIDTH + GAP),
        y: 0,
        config: {},
      })),
      edges: Array.from({ length: count - 1 }, (_, at) => ({ id: `e${at}`, from: `n${at}`, fromPort: 'out', to: `n${at + 1}`, toPort: 'in' })),
    };
    const names = vi.spyOn(backWires, 'namesOf');

    try {
      const { moved } = placeAfter(flow, 'n100', 'out', 'debug', MEASURE);

      expect(Object.keys(moved)).toHaveLength(count - 101);
      expect(names.mock.calls.length).toBeLessThan(count);
    } finally {
      names.mockRestore();
    }
  });

  it('moves the chain along over a row laid 40 under it, and not the row', () => {
    const flow = click(rows(), { node: 'start' }, 'debug', 'say');

    expect(['say', 'a', 'b', 'c', 'end'].map((id) => nodeOf(flow, id).x)).toEqual([284, 568, 852, 1136, 1420]);
    expect(['x', 'y'].map((id) => nodeOf(flow, id))).toMatchObject([{ x: 600, y: 120 }, { x: 900, y: 120 }]);
    expect([...overlapsIn(flow), ...wrongWith(flow)]).toEqual([]);
  });
});

describe('the examples', () => {
  it('are whole flowcharts: every way out wired, every node reached from Start', () => {
    for (const flow of exampleFlows()) {
      expect(unwiredOuts(flow)).toEqual(new Set());
      expect(unreached(flow)).toEqual(new Set());
      expect(flow.nodes.filter((node) => node.type === 'start')).toHaveLength(1);
    }
  });

  // As the canvas draws them: a node's ports stand at half its height, the If is DECISION_WIDTH by
  // DECISION_HEIGHT, and every other node NODE_WIDTH across and STEP_HEIGHT down. Two nodes whose
  // heights overlap stand on one row, with room between them for a way out's name; and a wire from a
  // way out on the right to the next node's way in on the left, along a row, runs level.
  it('are laid out for the shapes the canvas draws', () => {
    const boxOf = (node: FlowNodeDto) =>
      node.type === 'if' ? { width: DECISION_WIDTH, height: DECISION_HEIGHT } : { width: NODE_WIDTH, height: STEP_HEIGHT };
    const onOneRow = (a: FlowNodeDto, b: FlowNodeDto) => a.y < b.y + boxOf(b).height && b.y < a.y + boxOf(a).height;

    for (const flow of exampleFlows()) {
      for (const a of flow.nodes)
        for (const b of flow.nodes)
          if (a !== b && onOneRow(a, b) && a.x <= b.x)
            expect(b.x - (a.x + boxOf(a).width), `${a.id} to ${b.id}`).toBeGreaterThanOrEqual(96);

      for (const edge of flow.edges) {
        const from = flow.nodes.find((node) => node.id === edge.from)!;
        const to = flow.nodes.find((node) => node.id === edge.to)!;
        if (sideOf(edge.fromPort) !== 'right' || sideOf(edge.toPort, false) !== 'left' || !onOneRow(from, to)) continue;

        expect(Math.abs(from.y + boxOf(from).height / 2 - (to.y + boxOf(to).height / 2)), edge.id).toBeLessThan(0.5);
      }
    }
  });

  // And for the way a wire is drawn round what stands between its ends (backWires.ts): each of the
  // examples' wires drawn round is routed as the canvas routes it, over the nodes as Chrome draws them,
  // and runs through no node and no port's name, and on no other wire but where two go into one port
  // together. Their only such wires are their loops' returns: every other wire runs forward, to a way
  // in further right, and is drawn as the curve it is.
  it('leave every wire drawn round a clear way, and draw round only their loops’ returns', () => {
    for (const flow of exampleFlows()) {
      expect(wrongWith(flow), flow.name).toEqual([]);
      expect(routedIn(flow).drawn.map(({ leg }) => leg.id).sort(), flow.name).toEqual(
        flow.edges.filter((edge) => edge.toPort === 'next').map((edge) => edge.id).sort(),
      );
    }
  });
});
