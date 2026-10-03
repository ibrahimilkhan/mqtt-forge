import { getBezierPath } from '@xyflow/react';
import type { FlowDto, FlowNodeDto, FlowNodeType } from '../../types/api';
import { backPath, MARGIN, namesOf, POSITIONS, routes, type Box, type End, type Leg, type Placed, type Route } from './backWires';
import { DECISION_HEIGHT, DECISION_WIDTH, MEASURE, NODE_WIDTH, STEP_HEIGHT } from './FlowCanvas';
import { addNode, emptyFlow, freeSpot, insertAfter, insertOnWire, moveNodes, noReturn, placeAfter, unwiredOuts } from './flowDocument';
import { NODE_SPECS, portsOf, sideOf, specOf } from './nodeTypes';

/*
 * What the cases about wires need: a flow as Chrome draws it and React Flow measures it, the clicks
 * of the palette that make one — one by one, or a whole session of them at random from a seed — and
 * what each wire runs through once it is drawn, drawn round or the curve. jsdom lays nothing out, so
 * a canvas drawn there has every node a pixel square; the wires are reckoned here over the boxes the
 * browser draws instead, as the reviews that found them wanting did.
 */

/** The box Chrome draws a node of each type in: the If's diamond in its own, every other shape NODE_WIDTH by STEP_HEIGHT. */
export const drawnBox = (type: string) =>
  specOf(type).shape === 'decision' ? { width: DECISION_WIDTH, height: DECISION_HEIGHT } : { width: NODE_WIDTH, height: STEP_HEIGHT };

/**
 * Where React Flow ends a wire at a port, as FlowCanvas.module.css stands the port: a 10-pixel handle
 * whose middle is on the node's padding edge, a pixel in from its frame, at the middle of its side —
 * on the parallelogram's slanted sides 5% in — and the wire at the handle's outer edge.
 */
export function endAt(node: FlowNodeDto, port: string, out: boolean): End {
  const { width, height } = drawnBox(node.type);
  const slant = specOf(node.type).shape === 'input' ? 0.05 * (width - 2) : 0;
  const side = sideOf(port, out);

  switch (side) {
    case 'left':
      return { x: node.x + 1 + slant - 5, y: node.y + height / 2, side };
    case 'right':
      return { x: node.x + width - 1 - slant + 5, y: node.y + height / 2, side };
    case 'top':
      return { x: node.x + width / 2, y: node.y + 1 - 5, side };
    case 'bottom':
      return { x: node.x + width / 2, y: node.y + height - 1 + 5, side };
  }
}

/** A flow as the routes take it once it is drawn: each node's box with the names round it, and each wire's two ends. */
export function drawnAs(flow: FlowDto): { nodes: Placed[]; legs: Leg[] } {
  const open = unwiredOuts(flow);
  const unreturned = noReturn(flow);
  const nodes = flow.nodes.map((node) => {
    const box = { x: node.x, y: node.y, ...drawnBox(node.type) };
    const ports = portsOf(node, flow.edges);
    const unwired = [...ports.outs.filter((port) => open.has(`${node.id}:${port}`)), ...(unreturned.has(node.id) ? ['next'] : [])];
    return { id: node.id, box, names: namesOf(box, node.type, ports, unwired) };
  });
  const byId = new Map(flow.nodes.map((node) => [node.id, node]));
  const legs = flow.edges.map((edge) => ({
    id: edge.id,
    from: edge.from,
    to: edge.to,
    toPort: edge.toPort,
    source: endAt(byId.get(edge.from)!, edge.fromPort, true),
    target: endAt(byId.get(edge.to)!, edge.toPort, false),
  }));
  return { nodes, legs };
}

/**
 * A palette click, as the page makes one: the node put after the node picked, or on the wire picked,
 * where the page puts it, with what it moves to make room.
 */
export function clicked(flow: FlowDto, pick: { node: string } | { wire: string }, type: FlowNodeType, id: string): FlowDto {
  if ('wire' in pick) {
    const wire = flow.edges.find((edge) => edge.id === pick.wire)!;
    const { at, moved } = placeAfter(flow, wire.from, wire.fromPort, type, MEASURE);
    return insertOnWire(moveNodes(flow, moved), wire.id, type, at, id);
  }

  const after = flow.nodes.find((node) => node.id === pick.node)!;
  const { at, moved } = placeAfter(flow, after.id, specOf(after.type).outs[0], type, MEASURE);
  return insertAfter(moveNodes(flow, moved), after.id, type, at, id)!;
}

type Point = { x: number; y: number };

/**
 * The points along a path, a pixel or so apart: its straight runs and rounded corners, as a wire
 * drawn round is drawn, and React Flow's curve, as every other wire is.
 */
export function sampled(d: string): Point[] {
  const steps = [...d.matchAll(/([MLQC])([^MLQC]*)/g)].map(([, command, numbers]) => ({
    command,
    values: numbers.trim().split(/[ ,]+/).map(Number),
  }));
  const points: Point[] = [];
  let at: Point = { x: 0, y: 0 };

  for (const { command, values } of steps) {
    if (command === 'M') {
      at = { x: values[0], y: values[1] };
      points.push(at);
    } else if (command === 'L') {
      const to = { x: values[0], y: values[1] };
      const count = Math.max(1, Math.ceil(Math.hypot(to.x - at.x, to.y - at.y)));
      for (let step = 1; step <= count; step++)
        points.push({ x: at.x + ((to.x - at.x) * step) / count, y: at.y + ((to.y - at.y) * step) / count });
      at = to;
    } else if (command === 'Q') {
      const [cx, cy, x, y] = values;
      for (let step = 1; step <= 12; step++) {
        const t = step / 12;
        points.push({
          x: (1 - t) ** 2 * at.x + 2 * (1 - t) * t * cx + t * t * x,
          y: (1 - t) ** 2 * at.y + 2 * (1 - t) * t * cy + t * t * y,
        });
      }
      at = { x, y };
    } else {
      // A curve is never longer than the line through its control points, so that many steps are a pixel or less apart.
      const [ax, ay, bx, by, x, y] = values;
      const reach = Math.hypot(ax - at.x, ay - at.y) + Math.hypot(bx - ax, by - ay) + Math.hypot(x - bx, y - by);
      const count = Math.max(1, Math.ceil(reach));
      for (let step = 1; step <= count; step++) {
        const t = step / count;
        const u = 1 - t;
        points.push({
          x: u ** 3 * at.x + 3 * u * u * t * ax + 3 * u * t * t * bx + t ** 3 * x,
          y: u ** 3 * at.y + 3 * u * u * t * ay + 3 * u * t * t * by + t ** 3 * y,
        });
      }
      at = { x, y };
    }
  }

  return points;
}

/** The straight runs of a path, each from where the last one ended or its corner rounded off. */
function runsOf(d: string) {
  const steps = [...d.matchAll(/([MLQ])([^MLQ]*)/g)].map(([, command, numbers]) => ({
    command,
    values: numbers.trim().split(/[ ,]+/).map(Number),
  }));
  const runs: Array<{ from: Point; to: Point }> = [];
  let at: Point = { x: 0, y: 0 };

  for (const { command, values } of steps) {
    const to = command === 'Q' ? { x: values[2], y: values[3] } : { x: values[0], y: values[1] };
    if (command === 'L') runs.push({ from: at, to });
    at = to;
  }

  return runs;
}

const inside = (box: Box, { x, y }: Point, inset = 1.5) =>
  x > box.x + inset && x < box.x + box.width - inset && y > box.y + inset && y < box.y + box.height - inset;

/** A wire drawn round, as the canvas draws it: its leg, its route and its path. */
export type Drawn = { leg: Leg; route: Route; d: string };

/** Every wire of a flow as the canvas draws it, over the flow as Chrome draws it: round, along its route, or React Flow's curve. */
export function wiresIn(flow: FlowDto): { nodes: Placed[]; wires: Array<{ leg: Leg; route: Route | undefined; d: string }> } {
  const { nodes, legs } = drawnAs(flow);
  const found = routes(nodes, legs);
  const wires = legs.map((leg) => {
    const route = found.get(leg.id);
    const d = route
      ? backPath({ source: leg.source, target: leg.target, corners: route })
      : getBezierPath({
          sourceX: leg.source.x,
          sourceY: leg.source.y,
          sourcePosition: POSITIONS[leg.source.side],
          targetX: leg.target.x,
          targetY: leg.target.y,
          targetPosition: POSITIONS[leg.target.side],
        })[0];
    return { leg, route, d };
  });
  return { nodes, wires };
}

/** The wires of a flow the canvas draws round, routed over the flow as Chrome draws it. */
export function routedIn(flow: FlowDto): { nodes: Placed[]; drawn: Drawn[] } {
  const { nodes, wires } = wiresIn(flow);
  return { nodes, drawn: wires.flatMap(({ leg, route, d }) => (route ? [{ leg, route, d }] : [])) };
}

/**
 * Everything wrong with a flow's wires as the canvas draws them, as sentences, so a case that fails
 * says which wire and what it ran through:
 * - a node any wire runs through — drawn round, or the curve — other than its own two at their ports
 *   (ten pixels from either end);
 * - a port's name any wire runs through;
 * - another wire drawn round that one drawn round lies on, or runs beside closer than 16, along a run
 *   longer than four pixels — but for the last runs of two wires into the same port, where they meet
 *   and go in together;
 * - the stub of a curve — its first MARGIN out of its port, or its last into the other, which the
 *   routes hold for it — that a wire drawn round lies on or runs beside closer than 16, in the same way:
 *   out of an alarm's foot and up into the End level with it, a wire ran into the End along the start
 *   of the curve out of the alarm's side, and the two read as one line out of the side.
 */
export function wrongWith(flow: FlowDto): string[] {
  const { nodes, wires } = wiresIn(flow);
  const drawn = wires.flatMap(({ leg, route, d }) => (route ? [{ leg, route, d }] : []));
  const wrong: string[] = [];

  for (const { leg, route, d } of wires) {
    const points = sampled(d);
    const [first, last] = [points[0], points[points.length - 1]];
    const near = (point: Point, end: Point) => Math.hypot(point.x - end.x, point.y - end.y) < 10;
    const how = route ? 'runs' : 'curves';
    const through = nodes.filter(({ id, box }) =>
      points.some((point) => inside(box, point) && !((id === leg.from && near(point, first)) || (id === leg.to && near(point, last)))),
    );
    for (const node of through) wrong.push(`${leg.id} ${how} through ${node.id}`);

    for (const node of nodes)
      if (node.names.some((name) => points.some((point) => inside(name, point, 0)))) wrong.push(`${leg.id} ${how} through a name of ${node.id}`);
  }

  for (const [at, a] of drawn.entries())
    for (const b of drawn.slice(at + 1)) {
      const together = `${a.leg.to}:${a.leg.toPort}` === `${b.leg.to}:${b.leg.toPort}`;
      const [ra, rb] = [runsOf(a.d), runsOf(b.d)];
      // Into one port, the last runs of each are how it goes in: down onto a next, or down beside a
      // way in and into it.
      const into = a.leg.target.side === 'top' ? 1 : 2;
      const approach = (runs: ReturnType<typeof runsOf>, index: number) => index >= runs.length - into;

      for (const [i, r] of ra.entries())
        for (const [j, s] of rb.entries()) {
          const level = Math.abs(r.from.y - r.to.y) < 0.01 && Math.abs(s.from.y - s.to.y) < 0.01 && Math.abs(r.from.y - s.from.y) < 15.99;
          const upright = Math.abs(r.from.x - r.to.x) < 0.01 && Math.abs(s.from.x - s.to.x) < 0.01 && Math.abs(r.from.x - s.from.x) < 15.99;
          if (!level && !upright) continue;

          const [ar, br] = level ? [[r.from.x, r.to.x], [s.from.x, s.to.x]] : [[r.from.y, r.to.y], [s.from.y, s.to.y]];
          const shared = Math.min(Math.max(...ar), Math.max(...br)) - Math.max(Math.min(...ar), Math.min(...br));
          if (shared <= 4 || (together && approach(ra, i) && approach(rb, j))) continue;

          const apart = level ? Math.abs(r.from.y - s.from.y) : Math.abs(r.from.x - s.from.x);
          const where = level ? `at y ${r.from.y} and ${s.from.y}` : `at x ${r.from.x} and ${s.from.x}`;
          wrong.push(`${a.leg.id} and ${b.leg.id} ${apart < 0.5 ? 'lie on one line' : 'run side by side'} ${where} for ${Math.round(shared)}`);
        }
    }

  const stubs = wires.flatMap(({ leg, route }) => (route ? [] : stubsOf(leg)));
  for (const { leg, d } of drawn) {
    const runs = runsOf(d);
    const into = `${leg.to}:${leg.toPort}`;
    const approach = (index: number) => index >= runs.length - (leg.target.side === 'top' ? 1 : 2);
    for (const [index, r] of runs.entries())
      for (const stub of stubs) {
        if (stub.into === into && approach(index)) continue;
        const level = Math.abs(r.from.y - r.to.y) < 0.01 && stub.from.y === stub.to.y && Math.abs(r.from.y - stub.from.y) < 15.99;
        const upright = Math.abs(r.from.x - r.to.x) < 0.01 && stub.from.x === stub.to.x && Math.abs(r.from.x - stub.from.x) < 15.99;
        if (!level && !upright) continue;

        const [ar, br] = level ? [[r.from.x, r.to.x], [stub.from.x, stub.to.x]] : [[r.from.y, r.to.y], [stub.from.y, stub.to.y]];
        const shared = Math.min(Math.max(...ar), Math.max(...br)) - Math.max(Math.min(...ar), Math.min(...br));
        if (shared <= 4) continue;

        const apart = level ? Math.abs(r.from.y - stub.from.y) : Math.abs(r.from.x - stub.from.x);
        wrong.push(`${leg.id} ${apart < 0.5 ? 'lies on' : 'runs beside'} the stub of ${stub.leg} for ${Math.round(shared)}`);
      }
  }

  return wrong;
}

/** The way a port on each side faces: the way a wire leaves it, or comes to it from. */
const OUT: Record<End['side'], Point> = { right: { x: 1, y: 0 }, left: { x: -1, y: 0 }, bottom: { x: 0, y: 1 }, top: { x: 0, y: -1 } };

/** A wire's two stubs, as the routes hold them (see stubsOf in backWires.ts): MARGIN out of its way out, and MARGIN in front of its way in. */
const stubsOf = (leg: Leg) =>
  [
    { end: leg.source, into: null },
    { end: leg.target, into: `${leg.to}:${leg.toPort}` },
  ].map(({ end, into }) => ({
    leg: leg.id,
    into,
    from: { x: end.x, y: end.y },
    to: { x: end.x + OUT[end.side].x * MARGIN, y: end.y + OUT[end.side].y * MARGIN },
  }));

/** Every two nodes of a flow that stand on one another, as Chrome draws them, each by its own box. */
export function overlapsIn(flow: FlowDto): string[] {
  const boxes = flow.nodes.map((node) => ({ id: node.id, x: node.x, y: node.y, ...drawnBox(node.type) }));
  return boxes.flatMap((a, at) =>
    boxes
      .slice(at + 1)
      .filter((b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height)
      .map((b) => `${a.id} stands on ${b.id}`),
  );
}

/** A small seeded generator (mulberry32): the same seed, the same numbers. */
function generator(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The flow with each wire named by its ends, `from.port>to.port`, which a way out's one wire makes
 * unique: the ids the page makes are random, and of two wires as wide the routes take the one with
 * the lower id first, so a session told by its seed would not come out the same again.
 */
export const named = (flow: FlowDto): FlowDto => ({
  ...flow,
  edges: flow.edges.map((edge) => ({ ...edge, id: `${edge.from}.${edge.fromPort}>${edge.to}.${edge.toPort}` })),
});

/** A new flow, its End called end and its wires named by their ends. */
export function freshFlow(): FlowDto {
  const flow = emptyFlow('Flow 1');
  const end = flow.nodes[1].id;
  return named({
    ...flow,
    id: 'f1',
    nodes: flow.nodes.map((node) => (node.id === end ? { ...node, id: 'end' } : node)),
    edges: flow.edges.map((edge) => ({ ...edge, to: 'end' })),
  });
}

/** Every type the palette puts down. */
const PLACEABLE = Object.values(NODE_SPECS)
  .filter((spec) => spec.placeable)
  .map((spec) => spec.type as FlowNodeType);

/**
 * Whether the node `id` stands somewhere clear in `flow`, as the palette puts a node: crowding no other
 * node (MEASURE.crowds) — its room clear of them, and no name of its own or theirs over the other or
 * in front of one of its ports, which would leave no way to that port clear of the name.
 */
function standsClear(flow: FlowDto, id: string) {
  const node = flow.nodes.find((one) => one.id === id)!;
  return flow.nodes.every((other) => other.id === id || !MEASURE.crowds(flow, node, other, MEASURE.room));
}

/**
 * A session of the palette from a new flow, made at random from `seed`, `length` steps long: each
 * step a node of any type the palette has, put on a wire picked or after a node picked — free in the
 * view when that node has no one way out, as the page puts it — or, now and then, a node dragged off
 * its row to somewhere clear. Each step with what it did, in words, and the flow after it.
 */
export function randomSession(seed: number, length: number): Array<{ step: string; flow: FlowDto }> {
  const random = generator(seed);
  const pick = <T,>(list: readonly T[]) => list[Math.floor(random() * list.length)];
  const made: Array<{ step: string; flow: FlowDto }> = [];
  let flow = freshFlow();

  for (let at = 0; at < length; at++) {
    let step = '';
    if (at > 0 && random() < 0.2) {
      // Off its row, and along it a little, snapped to the canvas's grid as a drag is.
      const node = pick(flow.nodes);
      for (let tries = 0; tries < 8 && step === ''; tries++) {
        const way = random() < 0.5 ? -1 : 1;
        const to = {
          x: node.x + Math.round(((random() - 0.5) * 320) / 8) * 8,
          y: node.y + way * Math.round((48 + random() * 200) / 8) * 8,
        };
        const there = moveNodes(flow, { [node.id]: to });
        if (!standsClear(there, node.id)) continue;
        flow = there;
        step = `drag ${node.id} to ${to.x},${to.y}`;
      }
    }

    if (step === '') {
      const type = pick(PLACEABLE);
      const id = `n${at}`;
      if (random() < 0.5) {
        const wire = pick(flow.edges);
        flow = clicked(flow, { wire: wire.id }, type, id);
        step = `${id} ${type} on ${wire.id}`;
      } else {
        const after = pick(flow.nodes);
        if (specOf(after.type).outs.length === 1) {
          flow = clicked(flow, { node: after.id }, type, id);
          step = `${id} ${type} after ${after.id}`;
        } else {
          // Free, in the first clear place from the middle of the view, which may be anywhere over the flow.
          const xs = flow.nodes.map((node) => node.x);
          const ys = flow.nodes.map((node) => node.y);
          const middle = {
            x: Math.min(...xs) + random() * (Math.max(...xs) - Math.min(...xs)),
            y: Math.min(...ys) + random() * (Math.max(...ys) - Math.min(...ys)),
          };
          const spot = freeSpot(flow, middle, type, MEASURE.boxOf, 3, MEASURE.room, MEASURE);
          flow = addNode(flow, type, spot, id);
          step = `${id} ${type} free at ${spot.x},${spot.y} (${after.id} picked)`;
        }
      }
    }

    flow = named(flow);
    made.push({ step, flow });
  }

  return made;
}
