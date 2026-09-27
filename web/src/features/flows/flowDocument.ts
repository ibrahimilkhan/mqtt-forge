import type { FlowDto, FlowNodeType, FlowProblemDto } from '../../types/api';
import { NODE_SPECS } from './nodeTypes';

/*
 * Every change the page makes to a flow, as a function from one flow to the next. Nothing here
 * knows about the canvas or the store: the canvas turns a drag into moveNodes, the inspector turns
 * a keystroke into setConfig, and the store keeps whatever comes back. Which is also what makes
 * all of it testable without drawing anything.
 */

/** A wire, without its id. */
export type Wire = { from: string; fromPort: string; to: string; toPort: string };

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Eight random characters, lower case and digits: inside the server's ^[A-Za-z0-9_-]{1,40}$, short
 * enough to read in a network tab, and 36^8 is far past any number of nodes one console will make.
 */
export function newId(prefix = ''): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return prefix + Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join('');
}

export const emptyFlow = (name: string): FlowDto => ({ id: newId('f'), name, enabled: true, nodes: [], edges: [] });

/** "Flow 1", "Flow 2" … — the first number no flow is already called. */
export function nextName(flows: readonly FlowDto[]): string {
  const taken = new Set(flows.map((flow) => flow.name));
  for (let n = 1; ; n++) if (!taken.has(`Flow ${n}`)) return `Flow ${n}`;
}

export const addNode = (flow: FlowDto, type: FlowNodeType, at: { x: number; y: number }, id: string): FlowDto => ({
  ...flow,
  nodes: [...flow.nodes, { id, type, x: Math.round(at.x), y: Math.round(at.y), config: NODE_SPECS[type].defaults() }],
});

/** Where nodes now stand, rounded: a position is a place on a grid somebody looks at, not a measurement. */
export const moveNodes = (flow: FlowDto, moved: Record<string, { x: number; y: number }>): FlowDto => ({
  ...flow,
  nodes: flow.nodes.map((node) =>
    moved[node.id] ? { ...node, x: Math.round(moved[node.id].x), y: Math.round(moved[node.id].y) } : node,
  ),
});

/** Takes nodes away, and every wire that touched one of them. */
export function removeNodes(flow: FlowDto, ids: readonly string[]): FlowDto {
  const gone = new Set(ids);
  return {
    ...flow,
    nodes: flow.nodes.filter((node) => !gone.has(node.id)),
    edges: flow.edges.filter((edge) => !gone.has(edge.from) && !gone.has(edge.to)),
  };
}

export function removeEdges(flow: FlowDto, ids: readonly string[]): FlowDto {
  const gone = new Set(ids);
  return { ...flow, edges: flow.edges.filter((edge) => !gone.has(edge.id)) };
}

/**
 * Whether a wire may be drawn: both ends on nodes, ports that exist, not back to its own node,
 * not a second wire between the same two ports, and not closing a circle. The server refuses the
 * same five things; saying no while the wire is still being dragged is kinder than saying it at
 * deploy.
 */
export function canConnect(flow: FlowDto, wire: Wire): boolean {
  const from = flow.nodes.find((node) => node.id === wire.from);
  const to = flow.nodes.find((node) => node.id === wire.to);
  if (!from || !to || from.id === to.id) return false;

  if (!NODE_SPECS[from.type].outs.includes(wire.fromPort)) return false;
  if (!NODE_SPECS[to.type].ins.includes(wire.toPort)) return false;

  const twice = flow.edges.some(
    (edge) =>
      edge.from === wire.from && edge.fromPort === wire.fromPort && edge.to === wire.to && edge.toPort === wire.toPort,
  );
  if (twice) return false;

  return !reaches(flow, wire.to, wire.from);
}

/** Whether following wires forward from `start` ever arrives at `goal`. */
function reaches(flow: FlowDto, start: string, goal: string): boolean {
  const seen = new Set<string>();
  const waiting = [start];

  while (waiting.length > 0) {
    const at = waiting.pop()!;
    if (at === goal) return true;
    if (seen.has(at)) continue;
    seen.add(at);

    for (const edge of flow.edges) if (edge.from === at) waiting.push(edge.to);
  }

  return false;
}

/** The flow with the wire added, or the same flow when the wire may not be drawn. */
export const connect = (flow: FlowDto, wire: Wire, id: string = newId('e')): FlowDto =>
  canConnect(flow, wire) ? { ...flow, edges: [...flow.edges, { id, ...wire }] } : flow;

export const setConfig = (flow: FlowDto, nodeId: string, config: Record<string, unknown>): FlowDto => ({
  ...flow,
  nodes: flow.nodes.map((node) => (node.id === nodeId ? { ...node, config } : node)),
});

/**
 * Whether two flows are the same flow, setting for setting.
 *
 * Keys are put in order first, because the server hands back settings in the order they were
 * sent and an editor that rebuilt an object in another order has not changed anything.
 */
export const sameFlow = (a: FlowDto | undefined, b: FlowDto | undefined): boolean =>
  a !== undefined && b !== undefined && JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value === null || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, sorted((value as Record<string, unknown>)[key])]),
  );
}

/** The flows as the page shows them: each deployed flow or its draft, then drafts never deployed. */
export function withDrafts(deployed: readonly FlowDto[], drafts: Readonly<Record<string, FlowDto>>): FlowDto[] {
  const known = new Set(deployed.map((flow) => flow.id));

  return [
    ...deployed.map((flow) => drafts[flow.id] ?? flow),
    ...Object.values(drafts).filter((draft) => !known.has(draft.id)),
  ];
}

/** The server's problems, filed by flow and then by the key the page marks. */
export function problemsOf(problems: readonly FlowProblemDto[]): Record<string, Record<string, string[]>> {
  const filed: Record<string, Record<string, string[]>> = {};

  for (const problem of problems) {
    const flow = (filed[problem.flowId] ??= {});
    (flow[problem.key] ??= []).push(problem.message);
  }

  return filed;
}
