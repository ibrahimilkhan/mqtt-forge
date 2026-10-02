import type { FlowDto, FlowNodeType, FlowProblemDto } from '../../types/api';
import { NODE_SPECS, specOf } from './nodeTypes';

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

/** What a flow is called wherever it is named: its name, or Untitled when it has none. */
export const titleOf = (flow: FlowDto) => flow.name.trim() || 'Untitled';

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

/** How much room a node takes on the canvas, as the one putting a node down reckons it. */
export type Box = { width: number; height: number };

/**
 * Where the palette's adds start in the view, and how many places go to a row before the next row:
 * a node centred on the middle of the view, and as many beside it as fit, `gap` apart, before the
 * view's right edge. The middle and the edge are in the canvas's own units, so its zoom is already
 * in them.
 */
export function placesInView(middle: { x: number; y: number }, right: number, box: Box, gap: number) {
  const start = { x: middle.x - box.width / 2, y: middle.y - box.height / 2 };
  return { start, across: Math.floor((right - start.x + gap) / (box.width + gap)) };
}

/**
 * Where a node the palette adds goes: `start` if nothing is there, or else the first place along
 * from it — `across` places to a row, then down a row, `gap` apart — that touches no node the flow
 * has. Where the nodes stand decides it, not how many have been added, so a node dragged into the
 * way is stepped round like any other.
 *
 * The places are reckoned from `start` rounded, because that is where a node put there is kept
 * (see addNode). Reckoned from up to half a pixel short of it, the node just put down reached that
 * far into the next place along, and every add passed over a place that was free.
 *
 * Every node can stand in the way of four places at most, so one of the first few past four for
 * each node is free; the count stops the search at that, whatever the flow holds.
 */
export function freeSpot(
  flow: FlowDto,
  start: { x: number; y: number },
  box: Box,
  across: number,
  gap: number,
): { x: number; y: number } {
  const first = { x: Math.round(start.x), y: Math.round(start.y) };
  const clear = (x: number, y: number) =>
    flow.nodes.every(
      (node) =>
        x + box.width + gap <= node.x ||
        node.x + box.width + gap <= x ||
        y + box.height + gap <= node.y ||
        node.y + box.height + gap <= y,
    );

  const columns = Math.max(1, Math.floor(across));
  const place = (index: number) => ({
    x: first.x + (index % columns) * (box.width + gap),
    y: first.y + Math.floor(index / columns) * (box.height + gap),
  });

  for (let index = 0; index <= 4 * flow.nodes.length; index++) {
    const spot = place(index);
    if (clear(spot.x, spot.y)) return spot;
  }

  return first;
}

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
 * deploy. A node of a type this build does not know has no ports here, as it has none on the
 * server, so no wire goes to or from it.
 */
export function canConnect(flow: FlowDto, wire: Wire): boolean {
  const from = flow.nodes.find((node) => node.id === wire.from);
  const to = flow.nodes.find((node) => node.id === wire.to);
  if (!from || !to || from.id === to.id) return false;

  if (!specOf(from.type).outs.includes(wire.fromPort)) return false;
  if (!specOf(to.type).ins.includes(wire.toPort)) return false;

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

/*
 * What is worked out about a flow is kept against the flow object, because no flow is ever
 * changed in place: an edit makes a new object, so an answer about an object never goes stale.
 * The page asks on every frame of a drag whether each draft still differs from what is running,
 * and a flow of two hundred nodes is tens of kilobytes of text. Kept, a frame works out the one
 * flow being dragged, and reads the answers for the rest.
 */

/** Each flow as text with its keys in order. */
const texts = new WeakMap<FlowDto, string>();

/** The last answer about each flow, and the flow it was compared with. */
const verdicts = new WeakMap<FlowDto, { other: FlowDto; same: boolean }>();

/** A flow as text, its keys in order: two flows that are the same flow read the same. */
function canonical(flow: FlowDto): string {
  let text = texts.get(flow);
  if (text === undefined) {
    text = JSON.stringify(sorted(flow));
    texts.set(flow, text);
  }
  return text;
}

/**
 * Whether two flows are the same flow, setting for setting.
 *
 * Keys are put in order first, because the server hands back settings in the order they were
 * sent and an editor that rebuilt an object in another order has not changed anything.
 */
export function sameFlow(a: FlowDto | undefined, b: FlowDto | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  if (a === b) return true;

  const last = verdicts.get(a);
  if (last?.other === b) return last.same;

  const same = canonical(a) === canonical(b);
  verdicts.set(a, { other: b, same });
  return same;
}

/** Each flow's fingerprint. */
const prints = new WeakMap<FlowDto, string>();

/**
 * A short stand-in for everything a flow says: what a draft keeps to remember which copy on the
 * server it was started from. The server sends no version of a flow, so the page makes one from the
 * flow itself. Two copies that are the same flow have the same fingerprint however their keys were
 * ordered, and a copy that anybody has changed since has another.
 *
 * A hash, not the text, because it is kept beside every draft, and a flow's text is tens of
 * kilobytes. 53 bits of cyrb53, which is quick and which anybody could forge: nothing here guards
 * against anybody, it only tells apart the copies of one flow that consoles deploy.
 */
export function fingerprint(flow: FlowDto): string {
  let print = prints.get(flow);
  if (print === undefined) {
    print = hashOf(canonical(flow));
    prints.set(flow, print);
  }
  return print;
}

function hashOf(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;

  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * How a draft stands against the server's copy of its flow.
 *
 * - `nothing`: nothing of the reader's is in it. It says what the server has, or it says what the
 *   server had when it was started and the server has since moved on from, or let go of. It goes:
 *   kept, it would hide the server's newer copy, and go back out with the next Deploy.
 * - `changed`: an edit of the copy the server has, or a flow the server never had. Deploy sends it.
 * - `overtaken`: an edit of a copy the server has since replaced, or deleted. Deploy holds it back
 *   until the reader keeps it over the server's copy or discards it: sent as it stands, it would
 *   undo another console's work, or bring back a flow somebody deleted.
 *
 * `base` is the fingerprint of the copy the draft was started from: null for a flow started here.
 */
export type DraftStanding = 'nothing' | 'changed' | 'overtaken';

export function standingOf(draft: FlowDto, base: string | null, deployed: FlowDto | undefined): DraftStanding {
  if (sameFlow(draft, deployed)) return 'nothing';

  const now = deployed ? fingerprint(deployed) : null;
  if (base === now) return 'changed';

  return base !== null && fingerprint(draft) === base ? 'nothing' : 'overtaken';
}

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

/** What is wrong with one flow, as the server said it: keyed flow, node:{id} and edge:{id}. */
export type Problems = Readonly<Record<string, readonly string[]>>;

/** The server's problems, filed by flow and then by the key the page marks. */
export function problemsOf(problems: readonly FlowProblemDto[]): Record<string, Record<string, string[]>> {
  const filed: Record<string, Record<string, string[]>> = {};

  for (const problem of problems) {
    const flow = (filed[problem.flowId] ??= {});
    (flow[problem.key] ??= []).push(problem.message);
  }

  return filed;
}
