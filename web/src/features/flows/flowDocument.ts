import { own } from '../../lib/own';
import type { FlowDto, FlowEdgeDto, FlowNodeDto, FlowNodeType, FlowProblemDto } from '../../types/api';
import { isLoop, isNodeType, NODE_SPECS, sideOf, specOf } from './nodeTypes';

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

/**
 * A new flow: a Start wired to an End — the smallest whole program, and the wire a first step is
 * put on. Switched off: a flow runs when somebody Activates it, not when it is drawn.
 */
export const emptyFlow = (name: string): FlowDto => {
  const end = newId('n');

  return {
    id: newId('f'),
    name,
    enabled: false,
    variables: [],
    nodes: [
      { id: 'start', type: 'start', x: 40, y: 120, config: {} },
      { id: end, type: 'end', x: 360, y: 120, config: {} },
    ],
    edges: [{ id: newId('e'), from: 'start', fromPort: 'out', to: end, toPort: 'in' }],
  };
};

/** "Flow 1", "Flow 2" … — the first number no flow is already called. */
export function nextName(flows: readonly FlowDto[]): string {
  const taken = new Set(flows.map((flow) => flow.name));
  for (let n = 1; ; n++) if (!taken.has(`Flow ${n}`)) return `Flow ${n}`;
}

/** The flow with a new node of the type in it, its settings the type's defaults, and no wire to it yet. */
const withNode = (flow: FlowDto, type: FlowNodeType, at: { x: number; y: number }, id: string): FlowDto => ({
  ...flow,
  nodes: [...flow.nodes, { id, type, x: Math.round(at.x), y: Math.round(at.y), config: NODE_SPECS[type].defaults() }],
});

/**
 * A node put down away from the wires: where it was dropped on the canvas, or where the palette found
 * room for it. Its ways out are left unwired for the canvas to mark, but for a loop's body, which goes
 * back to the loop's own next as it does wherever a loop is put (see waysOut).
 */
export const addNode = (flow: FlowDto, type: FlowNodeType, at: { x: number; y: number }, id: string): FlowDto => {
  const added = withNode(flow, type, at, id);
  const ways = waysOut(id, type);

  // A node with no wire to make leaves the flow the very list of wires it had: handed a new one, the
  // canvas draws every wire again.
  return ways.length === 0 ? added : { ...added, edges: [...added.edges, ...ways] };
};

/**
 * A node put on a wire: the wire now runs into it, and every way out it has goes where the wire went —
 * a decision's yes and no alike. A loop put on a wire gets an empty body, wired to its own next, and
 * its done goes where the wire went. Nothing is left unwired.
 *
 * An End has no way out, though. Put on a wire, it ends the run there, and what the wire led to is
 * left for the reader to wire again or take out: a step nothing else led to is reached no more, and
 * a loop whose last way back the wire was has nothing coming back to it. The canvas marks either.
 */
export function insertOnWire(
  flow: FlowDto,
  edgeId: string,
  type: FlowNodeType,
  at: { x: number; y: number },
  id: string,
): FlowDto {
  const wire = flow.edges.find((edge) => edge.id === edgeId);
  if (!wire) return flow;

  const added = withNode(flow, type, at, id);
  return {
    ...added,
    edges: [
      ...added.edges.filter((edge) => edge.id !== edgeId),
      { id: newId('e'), from: wire.from, fromPort: wire.fromPort, to: id, toPort: 'in' },
      ...waysOut(id, type, wire),
    ],
  };
}

/**
 * The wires out of a node just put down. A loop's body goes back to the loop's own next, wherever
 * the loop is put: that is how a loop is drawn until a step is put on the wire, and a loop with
 * nothing coming back to it is one the server refuses. Every other way out goes where `onward` led,
 * or, when there was no wire to follow, is left unwired for the canvas to mark.
 */
function waysOut(id: string, type: FlowNodeType, onward?: { to: string; toPort: string }): FlowEdgeDto[] {
  return NODE_SPECS[type].outs.flatMap((port) => {
    if (isLoop(type) && port === 'body') return [{ id: newId('e'), from: id, fromPort: port, to: id, toPort: 'next' }];
    return onward ? [{ id: newId('e'), from: id, fromPort: port, to: onward.to, toPort: onward.toPort }] : [];
  });
}

/**
 * A node put after one with a single way out: on that way out's wire when it has one, and wired
 * straight from it when it has none — a loop with its empty body, and any other way out the new
 * node has left unwired, since there is no wire end to send it to. Null for a node with no way out,
 * or with two — which of them the reader meant is theirs to say, by picking the wire.
 */
export function insertAfter(
  flow: FlowDto,
  nodeId: string,
  type: FlowNodeType,
  at: { x: number; y: number },
  id: string,
): FlowDto | null {
  const node = flow.nodes.find((one) => one.id === nodeId);
  const outs = node ? specOf(node.type).outs : [];
  if (outs.length !== 1) return null;

  const wire = flow.edges.find((edge) => edge.from === nodeId && edge.fromPort === outs[0]);
  if (wire) return insertOnWire(flow, wire.id, type, at, id);

  const added = withNode(flow, type, at, id);
  return {
    ...added,
    edges: [...added.edges, { id: newId('e'), from: nodeId, fromPort: outs[0], to: id, toPort: 'in' }, ...waysOut(id, type)],
  };
}

/** How much room a node takes on the canvas, as the one putting a node down reckons it. */
export type Box = { width: number; height: number };

/**
 * The room a node of each type takes. Handed in by whoever draws the nodes, which knows their sizes:
 * an If's diamond stands in a box of its own, larger than a step's.
 */
export type BoxOf = (type: string) => Box;

/**
 * Whether two nodes, standing where `flow` has them and wired as it has them, crowd each other as
 * they are drawn: nearer than `room`; a name written beside a port of the one over the other, or in
 * front of one of its ports — where no wire could come in or go out but through the name; or a port of
 * either facing the other nearer than the room a wire takes out of it and round that node, whatever
 * `room` is. Handed in by whoever draws the nodes, which knows where it writes the names and stands the
 * ports.
 */
export type Crowds = (flow: FlowDto, a: FlowNodeDto, b: FlowNodeDto, room: number) => boolean;

/**
 * How the palette reckons the nodes it puts down, handed in by whoever draws them: the room each
 * takes (boxOf), how tall each is drawn, to stand a node level with the one it follows, the room it
 * keeps clear round a node it puts down free (room), and round one it puts after another (margin),
 * whether two nodes crowd each other (crowds), and how far past its box anything of a node's stands
 * that another node is kept clear of (reach).
 */
export type Measure = { boxOf: BoxOf; heightOf: (type: string) => number; room: number; margin: number; crowds: Crowds; reach: number };

/**
 * How far one node's right edge stands from the next one's left along a row, as the examples are
 * laid out: a way out's name stands in it, past where a wire going back turns up, and the wire
 * between the two runs level across it.
 */
export const GAP = 96;

/**
 * How far apart the rows of a flowchart stand, middle to middle, as the examples' are: a way out at a
 * node's foot leads down to the next row, far enough under it that the port's name clears what
 * stands there.
 */
export const ROW = 176;

type Place = { x: number; y: number };

/** Whether a node of box `box` at `at` stands `room` clear of `node`, each by its own box. */
const apart = (at: Place, box: Box, node: FlowNodeDto, other: Box, room: number) =>
  at.x + box.width + room <= node.x ||
  node.x + other.width + room <= at.x ||
  at.y + box.height + room <= node.y ||
  node.y + other.height + room <= at.y;

/**
 * Where the palette puts a node of `type` after `nodeId`'s way out `port` — on that way out's wire,
 * or wired to it when it has none — and the nodes it moves to make room there.
 *
 * On the row of the node it follows, GAP to its right, level with it: an If, taller than a step,
 * stands higher by half the difference, so its ports and the wire between them are level. A way out
 * at the node's foot leads down instead, as the examples' do: the node goes on the row under it, its
 * way in to the right of the foot. Beside the node is where its other way out goes — a loop's body,
 * an If's yes, a Raise alarm's raised — and a node put there for the foot's wire looked like the next
 * step of the other, and stood across that wire's way.
 *
 * That place is often taken, by the node the wire went on to: a new flow's End stands where the
 * first step goes. It used to step the node a row down, and a chain clicked together from the Start
 * went down a row with each click, its last wire going back up to the End. It makes room instead: the
 * node the wire led to, and everything a run gets to from it (see onwardFrom), that stands at or right
 * of the place moves right by the new node's width and the gap, as a reader pushing the rest of the
 * chain along would. So a chain stays on its row and the End goes along at its end. When what stands
 * there is something else, which moving the rest of the chain would not clear, nothing moves, and the
 * node goes in the first clear place from there (freeSpot).
 *
 * And what moves never lands on what stays. A node the reader put down on the row ahead — the chain's
 * End pushed along onto it — or a step of another branch standing where the chain goes: whatever a
 * moved node would crowd (see Crowds) moves along too, with what a run gets to from it standing at or
 * right of it, until nothing moved crowds anything that stays.
 *
 * In the way, and landing on what stays, is crowding by a wire's margin (`measure.margin`), not by the
 * wider room a node put down free keeps: the rows the palette lays out stand far further apart than
 * either, and at the wider room an If put on an If's no, 48 under it, counted the If it follows as in
 * its way and went three places along, and a row a reader laid 40 under a chain was pushed along
 * with it, or had a node clicked into the chain go two rows down. A port still keeps room in front of
 * it (see Crowds), two margins, which is what the wires out of it and into what it faces need between
 * them: at the wider room a For clicked into the chain went a row down past a row laid 40 under it,
 * whose ways in face the chain. The node it is put after is never in its way: the place is worked out
 * from it, and the wire between the two is what the place is for.
 */
export function placeAfter(
  flow: FlowDto,
  nodeId: string,
  port: string,
  type: FlowNodeType,
  measure: Measure,
): { at: Place; moved: Record<string, Place> } {
  const { boxOf, heightOf, crowds, margin } = measure;
  const node = flow.nodes.find((one) => one.id === nodeId)!;
  const middle = node.y + heightOf(node.type) / 2;
  const wanted =
    sideOf(port) === 'bottom'
      ? { x: node.x + boxOf(node.type).width / 2 + GAP / 2, y: middle + ROW - heightOf(type) / 2 }
      : { x: node.x + boxOf(node.type).width + GAP, y: middle - heightOf(type) / 2 };
  const at = { x: Math.round(wanted.x), y: Math.round(wanted.y) };

  // The flow as the click leaves it, but for what moves: the new node at the place, wired as it will
  // be, so that every port's name says what it will say there — a way out the new node takes the wire
  // of is no longer one that wants a wire.
  const wire = flow.edges.find((edge) => edge.from === nodeId && edge.fromPort === port);
  const drawn = (wire ? insertOnWire(flow, wire.id, type, at, PLACING) : insertAfter(flow, nodeId, type, at, PLACING)) ?? withNode(flow, type, at, PLACING);
  const placed = drawn.nodes.find((one) => one.id === PLACING)!;
  const inTheWay = flow.nodes.filter((one) => one.id !== nodeId && crowds(drawn, placed, one, margin));
  if (inTheWay.length === 0) return { at, moved: {} };

  const led = wire?.to;
  const wiring = wiringOf(flow.nodes, flow.edges);
  const byId = new Map(flow.nodes.map((one) => [one.id, one]));
  const ahead = (seed: string, from: number) =>
    [...onwardFrom(wiring, seed)].flatMap((id) => {
      const one = byId.get(id);
      return one !== undefined && one.x >= from ? [one] : [];
    });

  // The node the wire led to moves along too when it stands in the way a little left of the place —
  // put under the foot by hand — and far enough that it stands GAP past the new node, as the rest do.
  // Left where it stood, the new node went past it, and the wire to the new node through it.
  const moving = new Set(led === undefined ? [] : ahead(led, at.x));
  for (const one of inTheWay) if (one.id === led) for (const pushed of [one, ...ahead(one.id, one.x)]) moving.add(pushed);

  // Something else stands there. Beside a node, the first clear place down from there: further along
  // the row, the wire to it would run through what stands in the way. Under a foot, the first clear
  // place along the row under: what stands in the way stands under the foot, and a node put under it
  // had its wire go round it.
  if (!inTheWay.every((one) => moving.has(one)))
    return { at: freeSpot(flow, at, type, boxOf, sideOf(port) === 'bottom' ? ALONG : 1, measure.room, measure), moved: {} };

  const by = Math.max(boxOf(type).width + GAP, ...inTheWay.map((one) => at.x + boxOf(type).width + GAP - one.x));
  const landing = [...moving];
  while (landing.length > 0) {
    const mover = landing.pop()!;
    const lands = { ...mover, x: mover.x + by };
    for (const one of flow.nodes)
      if (!moving.has(one) && crowds(drawn, lands, one, margin))
        for (const pushed of [one, ...ahead(one.id, one.x)])
          if (!moving.has(pushed)) {
            moving.add(pushed);
            landing.push(pushed);
          }
  }

  return { at, moved: Object.fromEntries([...moving].map((one) => [one.id, { x: one.x + by, y: one.y }])) };
}

/** How many places along the row under a foot placeAfter looks for a clear one, before the rows under that. */
const ALONG = 3;

/** What the node being put down is called while placeAfter reckons where: no id the server takes, so none a flow has. */
const PLACING = '#placing';

/**
 * Everything a run gets to from `seed`, `seed` with it. A return into a loop's next goes back, to a
 * node that comes before; but the run does not end there: when the loop is done it goes on from the
 * loop's done, to whatever follows the loop, which stands further along. Stopping at the return, a
 * node put into a loop's body moved the rest of the body along onto the End after the loop, which
 * stayed where it was.
 */
function onwardFrom(wiring: Wiring, seed: string): Set<string> {
  const found = new Set([seed]);
  const waiting = [seed];
  const finished = new Set<string>();
  const reach = (id: string) => {
    if (found.has(id)) return;
    found.add(id);
    waiting.push(id);
  };

  while (waiting.length > 0)
    for (const edge of wiring.outs.get(waiting.pop()!) ?? []) {
      if (!isReturn(wiring, edge)) {
        reach(edge.to);
        continue;
      }
      if (finished.has(edge.to)) continue;
      finished.add(edge.to);
      for (const done of wiring.outs.get(edge.to) ?? []) if (done.fromPort === 'done' && done.to !== edge.to) reach(done.to);
    }

  return found;
}

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
 * Where a node of `type` the palette adds goes: `start` if nothing is there, or else the first place
 * along from it — `across` places to a row, then down a row, `gap` apart — that comes within `gap` of
 * no node the flow has. Where the nodes stand decides it, not how many have been added, so a node
 * dragged into the way is stepped round like any other.
 *
 * Each node by its own box, and the new one by its own (`boxOf`). Every node reckoned as a step, the
 * lower half of an If's diamond, half again as tall, was free ground, and a node put after the step
 * before the If went down onto it.
 *
 * The places are reckoned from `start` rounded, because that is where a node put there is kept
 * (see addNode). Reckoned from up to half a pixel short of it, the node just put down reached that
 * far into the next place along, and every add passed over a place that was free.
 *
 * With `crowding`, nothing of one may stand in the way of the other either (see Crowds): a node put
 * free has every way out it has wanting a wire, and a wire me written past its way out stood in front
 * of the way in of the node 56 along, where no wire could come in without running through the name.
 *
 * A node stands in the way of only so many places — as many across as its box, the new one's and
 * the gap on either side reach, with how far their names reach past them, and as many down — so one
 * of the first that many past them all is free; the count stops the search at that, whatever the
 * flow holds.
 */
export function freeSpot(
  flow: FlowDto,
  start: { x: number; y: number },
  type: string,
  boxOf: BoxOf,
  across: number,
  gap: number,
  crowding?: Pick<Measure, 'crowds' | 'reach'>,
): { x: number; y: number } {
  const box = boxOf(type);
  const first = { x: Math.round(start.x), y: Math.round(start.y) };
  const clear = (x: number, y: number) => {
    if (!flow.nodes.every((node) => apart({ x, y }, box, node, boxOf(node.type), gap))) return false;
    const put: FlowNodeDto = { id: PLACING, type: type as FlowNodeType, x, y, config: {} };
    return crowding === undefined || flow.nodes.every((node) => !crowding.crowds(flow, put, node, gap));
  };

  const columns = Math.max(1, Math.floor(across));
  const place = (index: number) => ({
    x: first.x + (index % columns) * (box.width + gap),
    y: first.y + Math.floor(index / columns) * (box.height + gap),
  });

  const room = gap + (crowding?.reach ?? 0);
  const reach = (span: number, step: number) => Math.floor(span / step) + 1;
  const tries = flow.nodes.reduce((count, node) => {
    const other = boxOf(node.type);
    return (
      count +
      reach(other.width + box.width + 2 * room, box.width + gap) * reach(other.height + box.height + 2 * room, box.height + gap)
    );
  }, 0);

  for (let index = 0; index <= tries; index++) {
    const spot = place(index);
    if (clear(spot.x, spot.y)) return spot;
  }

  return first;
}

/**
 * Where nodes now stand, rounded: a position is a place on a grid somebody looks at, not a measurement.
 * Only the nodes `moved` has of its own move: one called constructor or toString is not moved by what
 * every object answers to by that name (see own).
 */
export const moveNodes = (flow: FlowDto, moved: Readonly<Record<string, { x: number; y: number }>>): FlowDto => ({
  ...flow,
  nodes: flow.nodes.map((node) => {
    const to = own(moved, node.id);
    return to ? { ...node, x: Math.round(to.x), y: Math.round(to.y) } : node;
  }),
});

/**
 * Takes nodes away, and every wire that touched one. A node whose one way out was wired leaves the
 * wires that came into it joined to where that way out went, so taking a step out of a chain leaves
 * the chain whole. The Start is never taken away: every run begins there.
 */
export function removeNodes(flow: FlowDto, ids: readonly string[]): FlowDto {
  let next = flow;

  for (const id of ids) {
    const node = next.nodes.find((one) => one.id === id);
    if (!node || node.type === 'start') continue;

    const outs = specOf(node.type).outs;
    const onward = outs.length === 1 ? next.edges.find((edge) => edge.from === id && edge.fromPort === outs[0]) : undefined;

    const edges = next.edges.flatMap((edge) => {
      if (edge.from === id) return [];
      if (edge.to !== id) return [edge];
      return onward && onward.to !== id ? [{ ...edge, to: onward.to, toPort: onward.toPort }] : [];
    });

    next = { ...next, nodes: next.nodes.filter((one) => one.id !== id), edges };
  }

  return next;
}

export function removeEdges(flow: FlowDto, ids: readonly string[]): FlowDto {
  const gone = new Set(ids);
  return { ...flow, edges: flow.edges.filter((edge) => !gone.has(edge.id)) };
}

/**
 * Whether a wire may be drawn: both ends on nodes, ports that exist, no circle, and nothing coming
 * back to a loop's next from where no turn of that loop can be. Two ways out of one node may go to
 * the same place (an If whose yes and no both end the run). The server refuses the same things;
 * saying no while the wire is still being dragged is kinder than saying it when the flow is tested.
 * A node of a type this build does not know has no ports here, as it has none on the server, so no
 * wire goes to or from it.
 *
 * Asked of the flow as it would be with the wire, in place of the one its way out has, since
 * drawing a new one replaces it. A wire can spoil a return it does not touch: one into a loop's body
 * from its done, or from before the loop, makes a step a run reaches with no turn going, and that
 * step's wire back to next becomes one the server refuses. So the returns the wire could spoil are
 * judged again, and it is refused when it is a stray return itself or would make another one stray
 * (see strays). A return already stray is the flow's fault and not the wire's — testing the flow
 * says so — and holding it against every wire would leave the reader nothing to draw, not even the
 * wire that puts it right.
 */
export function canConnect(flow: FlowDto, wire: Wire): boolean {
  const from = flow.nodes.find((node) => node.id === wire.from);
  const to = flow.nodes.find((node) => node.id === wire.to);
  if (!from || !to) return false;

  if (!specOf(from.type).outs.includes(wire.fromPort)) return false;
  if (!specOf(to.type).ins.includes(wire.toPort)) return false;

  const back = wire.toPort === 'next' && isLoop(to.type);
  if (from.id === to.id) return back && wire.fromPort === 'body';

  const drawn: FlowEdgeDto = { id: '', from: wire.from, fromPort: wire.fromPort, to: wire.to, toPort: wire.toPort };
  const wiring = wiringOf(flow.nodes, [
    ...flow.edges.filter((edge) => !(edge.from === wire.from && edge.fromPort === wire.fromPort)),
    drawn,
  ]);

  // The one wire that may go back is a return, which no circle counts; any other closes one when
  // where it goes already leads, forward, to where it starts.
  if (!back && walk(wiring.outs, [wire.to], (edge) => !isReturn(wiring, edge)).has(wire.from)) return false;

  // A return turns stray only when a run can get to the node it comes from by a way it could not
  // before, and every such way goes through this wire. So the loops judged again are the one the
  // wire comes back to, if it does, and those with a return from somewhere the wire leads: in a flow
  // of many loops, a wire touches few of them.
  const onward = walk(wiring.outs, [wire.to], () => true);
  const touched = [...wiring.returns]
    .filter(([loop, returns]) => loop === wire.to || returns.some((edge) => onward.has(edge.from)))
    .map(([loop]) => loop);

  const now = strays(wiring, touched);
  if (now.size === 0) return true;

  // A stray return the flow already had is let be. The drawn wire is not one of the flow's, so a
  // stray one is refused here too.
  const had = straysOf(flow);
  return [...now].every((edge) => had.has(edge));
}

/**
 * The returns into the loops named — into every loop, unless they are named — that the server
 * refuses because a run gets to where they come from by the loop's done, or without going through
 * the loop at all. A turn ends when the run comes back to next, so only a node a turn can be at may
 * wire there: one of the loop's body that nothing before the loop and nothing after its done also
 * leads to, or the loop itself by its body, which is how an empty body is drawn. A run at a node a
 * stray return comes from would come to next with no turn going.
 *
 * A return from a node nothing leads to, neither the Start nor the loop, is refused by the server
 * too, and is not counted here. The canvas already draws that node as one nothing leads to, and the
 * reader is in the middle of wiring it: a body drawn from its last step back, or a step the wire
 * before it has just left. It is settled when something comes to lead there — through the body it
 * is the loop's own; any other way it turns stray, and canConnect refuses that wire.
 */
function strays(wiring: Wiring, loops: Iterable<string> = wiring.returns.keys()): Set<FlowEdgeDto> {
  const found = new Set<FlowEdgeDto>();
  const start = wiring.start;

  for (const loop of loops) {
    // An empty body's wire is the loop's own whatever leads to the loop: its turn never leaves it.
    const returns = (wiring.returns.get(loop) ?? []).filter((edge) => !(edge.from === loop && edge.fromPort === 'body'));
    if (returns.length === 0) continue;

    const after = region(wiring, loop, 'done');
    // Where a run gets to from the Start without going on through the loop: the loop is reached, not gone through.
    const outside = start === undefined ? new Set<string>() : walk(wiring.outs, [start], (edge) => edge.from !== loop);

    for (const edge of returns) if (after.has(edge.from) || outside.has(edge.from)) found.add(edge);
  }

  return found;
}

/*
 * Each flow's stray returns, kept against the flow object as the answers further down are: a wire
 * being dragged over a flow that already holds one asks about the same flow on every move.
 */
const strayReturns = new WeakMap<FlowDto, ReadonlySet<FlowEdgeDto>>();

function straysOf(flow: FlowDto): ReadonlySet<FlowEdgeDto> {
  let found = strayReturns.get(flow);
  if (found === undefined) {
    found = strays(wiringOf(flow.nodes, flow.edges));
    strayReturns.set(flow, found);
  }
  return found;
}

/**
 * A flow's wires as the walks follow them, made once for each question asked: each node's wires out,
 * by the node, so that a walk costs only the wires it follows. Looked for among all the wires at
 * every node it came to, a walk over a flow of two hundred nodes and four hundred wires took tens of
 * thousands of steps, and a wire being dragged asks on every move of the pointer.
 */
type Wiring = {
  outs: ReadonlyMap<string, readonly FlowEdgeDto[]>;
  /** The wires into each loop's next, by the loop: its returns. A loop with none has no entry. */
  returns: ReadonlyMap<string, readonly FlowEdgeDto[]>;
  loops: ReadonlySet<string>;
  start: string | undefined;
};

function wiringOf(nodes: readonly FlowNodeDto[], edges: readonly FlowEdgeDto[]): Wiring {
  const loops = new Set(nodes.filter((node) => isLoop(node.type)).map((node) => node.id));
  const outs = new Map<string, FlowEdgeDto[]>();
  const returns = new Map<string, FlowEdgeDto[]>();

  const file = (filed: Map<string, FlowEdgeDto[]>, key: string, edge: FlowEdgeDto) => {
    const list = filed.get(key);
    if (list) list.push(edge);
    else filed.set(key, [edge]);
  };

  for (const edge of edges) {
    file(outs, edge.from, edge);
    if (edge.toPort === 'next' && loops.has(edge.to)) file(returns, edge.to, edge);
  }

  return { outs, returns, loops, start: nodes.find((node) => node.type === 'start')?.id };
}

const isReturn = (wiring: Wiring, edge: FlowEdgeDto) => edge.toPort === 'next' && wiring.loops.has(edge.to);

/** Every node a run gets to from `seeds`, taking only the wires `takes` lets it. */
function walk(
  outs: ReadonlyMap<string, readonly FlowEdgeDto[]>,
  seeds: readonly string[],
  takes: (edge: FlowEdgeDto) => boolean,
): Set<string> {
  const found = new Set(seeds);
  const waiting = [...found];

  while (waiting.length > 0)
    for (const edge of outs.get(waiting.pop()!) ?? [])
      if (!found.has(edge.to) && takes(edge)) {
        found.add(edge.to);
        waiting.push(edge.to);
      }

  return found;
}

/** What one of a loop's ways out leads to, never going into the loop again: the server's Region. */
function region(wiring: Wiring, loop: string, port: string): Set<string> {
  const away = (edge: FlowEdgeDto) => edge.to !== loop;
  const first = (wiring.outs.get(loop) ?? []).filter((edge) => edge.fromPort === port && away(edge)).map((edge) => edge.to);
  return walk(wiring.outs, first, away);
}

/**
 * The flow with the wire added — in place of the wire its way out had, since a way out has one — or
 * the same flow when the wire may not be drawn. The same flow, too, when the way out already has
 * that wire: dropped again on the port it goes to, it is no change, and a new id would make it
 * read as one — a draft the page offers to save, of a flow nobody changed.
 */
export function connect(flow: FlowDto, wire: Wire, id: string = newId('e')): FlowDto {
  const had = flow.edges.filter((edge) => edge.from === wire.from && edge.fromPort === wire.fromPort);
  if (had.length === 1 && had[0].to === wire.to && had[0].toPort === wire.toPort) return flow;
  if (!canConnect(flow, wire)) return flow;

  return { ...flow, edges: [...flow.edges.filter((edge) => !had.includes(edge)), { id, ...wire }] };
}

export const setConfig = (flow: FlowDto, nodeId: string, config: Record<string, unknown>): FlowDto => ({
  ...flow,
  nodes: flow.nodes.map((node) => (node.id === nodeId ? { ...node, config } : node)),
});

/*
 * What a flow lacks to be a whole program, kept against the flow object as the answers below are:
 * the canvas asks again of the same flow whenever a pick, a size it measured or a refusal changes,
 * and an edit makes a new flow, so a kept answer never goes stale. A drag is an edit on every
 * frame, so each frame of one is worked out afresh.
 */
const unwiredOf = new WeakMap<FlowDto, ReadonlySet<string>>();
const unreachedOf = new WeakMap<FlowDto, ReadonlySet<string>>();
const noReturnOf = new WeakMap<FlowDto, ReadonlySet<string>>();

/**
 * Every way out of a known node that has no wire, as `nodeId:port`. The canvas draws them red: a run
 * that got there would have nowhere to go, and the server refuses the flow until each is wired.
 */
export function unwiredOuts(flow: FlowDto): ReadonlySet<string> {
  let found = unwiredOf.get(flow);
  if (found === undefined) {
    const wired = new Set(flow.edges.map((edge) => `${edge.from}:${edge.fromPort}`));
    found = new Set(
      flow.nodes.flatMap((node) =>
        isNodeType(node.type) ? NODE_SPECS[node.type].outs.map((port) => `${node.id}:${port}`).filter((key) => !wired.has(key)) : [],
      ),
    );
    unwiredOf.set(flow, found);
  }
  return found;
}

/** Every node no wire leads to from the Start. The canvas draws them faded; the server refuses them. */
export function unreached(flow: FlowDto): ReadonlySet<string> {
  let found = unreachedOf.get(flow);
  if (found === undefined) {
    const start = flow.nodes.find((node) => node.type === 'start');
    const reached = new Set<string>(start ? [start.id] : []);
    const waiting = start ? [start.id] : [];

    while (waiting.length > 0) {
      const at = waiting.pop()!;
      for (const edge of flow.edges)
        if (edge.from === at && !reached.has(edge.to)) {
          reached.add(edge.to);
          waiting.push(edge.to);
        }
    }

    found = new Set(flow.nodes.filter((node) => !reached.has(node.id) && node.type !== 'start').map((node) => node.id));
    unreachedOf.set(flow, found);
  }
  return found;
}

/**
 * Every loop nothing comes back to: no wire into its next, not even its own empty body's. The server
 * refuses such a loop, since a turn of it, once begun, would have no way to end — and every way out
 * can be wired and every node reached while it is so. A loop is put down with its body wired to its
 * own next, so it comes to this only when that wire, or its last wire back, ends at an End put on it
 * or is drawn somewhere else. The canvas marks the loop's next until something comes back to it.
 */
export function noReturn(flow: FlowDto): ReadonlySet<string> {
  let found = noReturnOf.get(flow);
  if (found === undefined) {
    const back = new Set(flow.edges.filter((edge) => edge.toPort === 'next').map((edge) => edge.to));
    found = new Set(flow.nodes.filter((node) => isLoop(node.type) && !back.has(node.id)).map((node) => node.id));
    noReturnOf.set(flow, found);
  }
  return found;
}

/**
 * The ports of a node of `flow` that want a wire, as the canvas marks them and the routes keep clear
 * of the names it writes there: its ways out with none (see unwiredOuts), out of `outs`, the ways out
 * it is drawn with; and its next, when it is a loop nothing comes back to (see noReturn).
 */
export function unwiredPorts(flow: FlowDto, node: FlowNodeDto, outs: readonly string[]): string[] {
  const open = unwiredOuts(flow);
  return [...outs.filter((port) => open.has(`${node.id}:${port}`)), ...(noReturn(flow).has(node.id) ? ['next'] : [])];
}

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

/**
 * A flow as text, its keys in order: two flows that are the same flow read the same.
 *
 * `enabled` is left out. A flow is switched on and off by Activate and Deactivate, not drawn on or
 * off, so it is never part of what a draft has changed: a flow switched on or off — here or on
 * another console — leaves every draft of it standing as it stood, and a draft never differs from
 * the server's copy by that alone.
 */
function canonical(flow: FlowDto): string {
  let text = texts.get(flow);
  if (text === undefined) {
    text = JSON.stringify(sorted({ ...flow, enabled: undefined }));
    texts.set(flow, text);
  }
  return text;
}

/**
 * Whether two flows are the same flow, setting for setting, switched on or not (see canonical).
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
 * A short stand-in for everything a flow says but whether it is switched on (see canonical): what a
 * draft keeps to remember which copy on the server it was started from. The server sends no version
 * of a flow, so the page makes one from the flow itself. Two copies that are the same flow have the
 * same fingerprint however their keys were ordered, and a copy that anybody has changed since has
 * another.
 *
 * A hash, not the text, because it is kept beside every draft, and a flow's text is tens of
 * kilobytes. 53 bits of cyrb53, which is quick and which anybody could forge: nothing here guards
 * against anybody, it only tells apart the copies of one flow that consoles save.
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
 *   kept, it would hide the server's newer copy, and go back out with the next Activate or Update.
 * - `changed`: an edit of the copy the server has, or a flow the server never had. Activate and
 *   Update send it.
 * - `overtaken`: an edit of a copy the server has since replaced, or deleted. Activate and Update
 *   hold it back until the reader keeps it over the server's copy or discards it: sent as it
 *   stands, it would undo another console's work, or bring back a flow somebody deleted.
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
    ...deployed.map((flow) => own(drafts, flow.id) ?? flow),
    ...Object.values(drafts).filter((draft) => !known.has(draft.id)),
  ];
}

/** What is wrong with one flow, as the server said it: keyed flow, node:{id} and edge:{id}. */
export type Problems = Readonly<Record<string, readonly string[]>>;

/**
 * The server's problems, filed by flow and then by the key the page marks: gathered in Maps, and made
 * records whose every key is its own (see own).
 */
export function problemsOf(problems: readonly FlowProblemDto[]): Record<string, Record<string, string[]>> {
  const filed = new Map<string, Map<string, string[]>>();

  for (const problem of problems) {
    const flow = filed.get(problem.flowId) ?? new Map<string, string[]>();
    filed.set(problem.flowId, flow);
    flow.set(problem.key, [...(flow.get(problem.key) ?? []), problem.message]);
  }

  return Object.fromEntries([...filed].map(([flowId, keys]) => [flowId, Object.fromEntries(keys)]));
}
