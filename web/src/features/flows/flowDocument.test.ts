import { describe, expect, it, vi } from 'vitest';
import type { FlowDto } from '../../types/api';
import {
  addNode,
  canConnect,
  connect,
  emptyFlow,
  freeSpot,
  moveNodes,
  newId,
  nextName,
  placesInView,
  problemsOf,
  removeEdges,
  removeNodes,
  sameFlow,
  setConfig,
  withDrafts,
} from './flowDocument';
import { exampleFlows } from './examples';
import { NODE_SPECS } from './nodeTypes';

const chain = (): FlowDto => {
  let flow = emptyFlow('Chain');
  flow = addNode(flow, 'inject', { x: 0, y: 0 }, 'a');
  flow = addNode(flow, 'forEach', { x: 200, y: 0 }, 'b');
  flow = addNode(flow, 'repeat', { x: 400, y: 0 }, 'c');
  flow = connect(flow, { from: 'a', fromPort: 'out', to: 'b', toPort: 'in' }, 'e1');
  return connect(flow, { from: 'b', fromPort: 'out', to: 'c', toPort: 'in' }, 'e2');
};

describe('flow document', () => {
  it('makes ids the server accepts', () => {
    for (let i = 0; i < 50; i++) expect(newId('n')).toMatch(/^n[a-z0-9]{8}$/);
  });

  it('names a new flow after the ones there are', () => {
    expect(nextName([])).toBe('Flow 1');
    expect(nextName([emptyFlow('Flow 1'), emptyFlow('Boiler watch')])).toBe('Flow 2');
  });

  it('adds a node with its type\'s defaults, where it was dropped', () => {
    const flow = addNode(emptyFlow('A'), 'publish', { x: 120, y: 80 }, 'p1');

    expect(flow.nodes).toEqual([{ id: 'p1', type: 'publish', x: 120, y: 80, config: NODE_SPECS.publish.defaults() }]);
  });

  it('moves nodes and rounds where they land', () => {
    const flow = moveNodes(chain(), { a: { x: 10.4, y: 20.6 } });

    expect(flow.nodes[0]).toMatchObject({ x: 10, y: 21 });
  });

  it('takes a removed node\'s wires with it', () => {
    const flow = removeNodes(chain(), ['b']);

    expect(flow.nodes.map((node) => node.id)).toEqual(['a', 'c']);
    expect(flow.edges).toEqual([]);
  });

  it('removes wires by id', () => {
    expect(removeEdges(chain(), ['e1']).edges.map((edge) => edge.id)).toEqual(['e2']);
  });

  it('refuses a wire that would go round in a circle, back to its own node, twice, or to a port that is not there', () => {
    const flow = chain();

    expect(canConnect(flow, { from: 'c', fromPort: 'out', to: 'b', toPort: 'in' })).toBe(false);
    expect(canConnect(flow, { from: 'b', fromPort: 'out', to: 'b', toPort: 'in' })).toBe(false);
    expect(canConnect(flow, { from: 'a', fromPort: 'out', to: 'b', toPort: 'in' })).toBe(false);
    expect(canConnect(flow, { from: 'a', fromPort: 'yes', to: 'c', toPort: 'in' })).toBe(false);
    expect(canConnect(flow, { from: 'a', fromPort: 'out', to: 'c', toPort: 'in' })).toBe(true);

    expect(connect(flow, { from: 'c', fromPort: 'out', to: 'b', toPort: 'in' })).toBe(flow);
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
    const flow = setConfig(before, 'c', { count: 5, seconds: 0 });

    expect(flow.nodes[2].config).toEqual({ count: 5, seconds: 0 });
    expect(flow.nodes[0]).toBe(before.nodes[0]);
  });

  it('calls two flows the same when only the order of keys in a setting differs', () => {
    // One chain, not two: two independent chain() calls would also differ in the flow's own
    // random id, which is not the order-of-keys difference this test is about.
    const base = chain();
    const a = setConfig(base, 'c', { count: 5, seconds: 0 });
    const b = setConfig(base, 'c', { seconds: 0, count: 5 });

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
    const at = (x: number, y: number): FlowDto => addNode(emptyFlow('Placed'), 'debug', { x, y }, 'there');

    it('goes where it was asked to when nothing is there', () => {
      expect(freeSpot(emptyFlow('Empty'), { x: 100, y: 50 }, box, 3, gap)).toEqual({ x: 100, y: 50 });
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
      let flow = emptyFlow('Placed');
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
