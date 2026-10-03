import { describe, expect, it, vi } from 'vitest';
import type { FlowDto, FlowNodeType } from '../../types/api';
import {
  addNode,
  bodyOf,
  canConnect,
  connect,
  emptyFlow,
  fingerprint,
  freeSpot,
  insertAfter,
  insertOnWire,
  moveNodes,
  newId,
  nextName,
  placesInView,
  problemsOf,
  removeEdges,
  removeNodes,
  sameFlow,
  setConfig,
  standingOf,
  unreached,
  unwiredOuts,
  withDrafts,
} from './flowDocument';
import { exampleFlows } from './examples';
import { NODE_SPECS } from './nodeTypes';

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
    const edited = { ...v1, enabled: false };

    it('holds nothing of the reader\'s when it says what the server has', () => {
      expect(standingOf({ ...v1 }, fingerprint(v1), v1)).toBe('nothing');
      expect(standingOf({ ...v2 }, fingerprint(v1), v2)).toBe('nothing');
    });

    it('is a change to deploy when it is an edit of the copy the server has, or of a flow the server never had', () => {
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
    /** A flow with no nodes at all, not even the Start and the End a new flow has: an empty canvas. */
    const bare = (): FlowDto => ({ ...emptyFlow('Placed'), nodes: [], edges: [] });
    const at = (x: number, y: number): FlowDto => addNode(bare(), 'debug', { x, y }, 'there');

    it('goes where it was asked to when nothing is there', () => {
      expect(freeSpot(bare(), { x: 100, y: 50 }, box, 3, gap)).toEqual({ x: 100, y: 50 });
    });

    it('steps across past a node in the way, and a gap beyond it', () => {
      expect(freeSpot(at(100, 50), { x: 100, y: 50 }, box, 3, gap)).toEqual({ x: 100 + 188 + 24, y: 50 });
    });

    it('goes down a row once the row is full', () => {
      let flow = at(100, 50);
      flow = addNode(flow, 'debug', { x: 312, y: 50 }, 'beside');

      expect(freeSpot(flow, { x: 100, y: 50 }, box, 2, gap)).toEqual({ x: 100, y: 50 + 80 + 24 });
    });

    // A node dragged half across the place the click would have used is in the way all the same.
    it('steps round a node that only covers part of a place', () => {
      expect(freeSpot(at(200, 90), { x: 100, y: 50 }, box, 1, gap)).toEqual({ x: 100, y: 50 + 2 * (80 + 24) });
    });

    // The middle of the view is seldom on a whole pixel, and a node is kept on one. Reckoned from
    // the start as given, the node just put there stood half a pixel into the next place along,
    // and every add passed over a place that was free.
    it('reckons its places from where a node put at the start is kept', () => {
      const start = { x: 100.6, y: 50.6 };
      let flow = bare();
      for (const id of ['a', 'b', 'c', 'd']) flow = addNode(flow, 'debug', freeSpot(flow, start, box, 3, gap), id);

      expect(flow.nodes.map(({ x, y }) => [x, y])).toEqual([[101, 51], [313, 51], [525, 51], [101, 155]]);
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

  it("replaces a way out's wire with a new one, since a way out has one", () => {
    const flow = { ...line(), nodes: [...line().nodes, { id: 'b', type: 'end', x: 0, y: 200, config: {} }] };

    expect(wires(connect(flow, { from: 'a', fromPort: 'out', to: 'b', toPort: 'in' }, 'e3'))).toEqual(['a.out>b.in', 'start.out>a.in']);
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
});

describe('the examples', () => {
  it('are whole flowcharts: every way out wired, every node reached from Start', () => {
    for (const flow of exampleFlows()) {
      expect(unwiredOuts(flow)).toEqual(new Set());
      expect(unreached(flow)).toEqual(new Set());
      expect(flow.nodes.filter((node) => node.type === 'start')).toHaveLength(1);
    }
  });
});
