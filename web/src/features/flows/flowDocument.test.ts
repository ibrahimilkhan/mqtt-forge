import { describe, expect, it } from 'vitest';
import type { FlowDto } from '../../types/api';
import {
  addNode,
  canConnect,
  connect,
  emptyFlow,
  moveNodes,
  newId,
  nextName,
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
});
