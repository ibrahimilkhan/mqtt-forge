import { isNodeType, nameOf, sideOf, type Ports, type Side } from './nodeTypes';

/*
 * How a wire is drawn when React Flow's curve would run through what stands between its ends.
 *
 * Every wire was React Flow's curve, which leaves a port and arrives at one along the sides they
 * stand on. Going forward, from a way out on the right to a way in further right, that is the line a
 * reader draws by hand. Going back it is not: a curve from a way out on the right into a next on top,
 * further left, came back through the very nodes it ran past — through the body of its own loop — and
 * one from a way out at the foot of a node, going back up to its loop, crossed whatever row stood
 * between.
 *
 * So a wire whose way in stands left of its way out goes round, the way a flowchart drawn by hand
 * does, square with its corners rounded, so it reads as a route and not as one more curve:
 * - one that has to climb to get there — its way in no lower than its way out — goes out of its port
 *   sideways, up past its node to a lane over what it would cross, back along it, and down onto the
 *   next from straight above, or down beside a way in and into it from its left;
 * - one going down to a way in further left runs down to a lane under the node it leaves, left along
 *   it, and in. Up over its own node and down again, it crossed the row it left twice, for nothing.
 *
 * And one out of a node's foot into a way in to its right that stands no lower than the foot goes
 * down to a lane under the node, along it, and up into the way in from its left. The curve turned
 * back up while it was still beside its node, and went through the node's lower corner, or through
 * the step after it on the row — an If's no to the End, past the step on its yes. Every other wire
 * stays the curve.
 *
 * Where each of them runs is worked out for all of them together (routes), from where every node
 * stands and how big it is drawn:
 * - A lane is the lowest that clears what it runs over: it goes over every node it would otherwise
 *   cross, and under a node standing wholly above it. A lane over every node between the two ends
 *   went up for nothing over such a node, and came down again through whatever stood under it.
 * - What rises and what comes down is kept clear too, and moves aside for a node in its way: a wire
 *   rises past it, and comes down onto a next where the next is, or into a way in from its left. The
 *   palette steps rows 104 apart, and a wire rising out of a node went up through the node above it.
 * - No two wires lie on one line. A lane keeps 16 from another one along the same stretch, a wire
 *   rising keeps 16 from another one beside it. A wire lights when a message goes down it, and on one
 *   line with another nobody could tell which had lit. The wires into one port are the exception:
 *   they come down to it, and go in, together.
 * - None of them runs through the name of a port.
 *
 * The narrowest are worked out first, so a loop inside another has its return under the outer one's —
 * nested, the two never cross — and what runs along under a row after what climbs out of it (see the
 * order in routes).
 */

/** How far past its node a wire turns up or down, how far left of a way in it comes down, and how far under a node a lane runs. */
export const MARGIN = 24;

/** How far above the nodes it runs over a lane runs. */
const OVER = 32;

/** How far apart two wires run beside each other. */
const STACK = 16;

/** How far clear of a port's name a wire keeps. */
const NAME_ROOM = 4;

/** The corners' radius. */
const CORNER = 8;

/**
 * Enough rounds of moving a lane and the runs up and down to it for any one wire: each round only
 * moves them on past what was in the way, so they settle in a few.
 */
const ROUNDS = 24;

export type Point = { x: number; y: number };

/** Where a node stands on the canvas and how big it is drawn, or where a port's name stands. */
export type Box = { x: number; y: number; width: number; height: number };

/** A port's end, as React Flow puts it: where a wire meets it, and the side of its node it stands on. */
export type End = Point & { side: Side };

/** A node, as the routes go round it: its box, and the names of its ports beside it. */
export type Placed = { id: string; box: Box; names: readonly Box[] };

/** A wire, as the routes take it: the nodes it joins, the port it goes into, and its two ends. */
export type Leg = { id: string; from: string; to: string; toPort: string; source: End; target: End };

/**
 * Where a wire drawn round runs: out of a way out at a node's foot down to `below`, along it under the
 * node, and up at `rise` — or out of one on the right to `rise` and up or down — or, `rise` null,
 * straight down out of its foot; then along `lane`, and down or up into a way in at `drop`. Onto a
 * next it comes down at the next. `below` is null but for a wire out of a foot that turns at `rise`.
 */
export type Route = { rise: number | null; below: number | null; lane: number; drop: number };

/** Which way a wire goes from its way out to its way in, and so how it is drawn (see the top of this file). */
export type Way = 'forward' | 'climbs' | 'descends' | 'rises';

/**
 * Which way a wire goes: the one test of it. The canvas draws each wire by it, and the examples are
 * held to the routes it decides on. The page, putting a node on a wire, no longer asks: it puts the
 * node after the node the wire leaves whichever way the wire goes (see placeAfter), where it used to
 * put it half-way along a wire going forward, by a test of its own that was not this one.
 */
export function wayOf(source: End, target: End): Way {
  if (target.x < source.x) return target.y > source.y ? 'descends' : 'climbs';
  return source.side === 'bottom' && target.side === 'left' && target.y < source.y ? 'rises' : 'forward';
}

/**
 * A port's name, as FlowCanvas.module.css stands it (`.port`), and as wide as the largest type the
 * appearance panel offers draws it, with some to spare: beside a port on the right, past where a wire
 * turns up there, its foot 6 above the port's middle; under a way out at the foot and over a next, 9
 * right of the port and 3 off the node. A node's frame is a pixel wide, and the stylesheet places a
 * name from inside it.
 */
const NAME_CHAR = 6.5;
const NAME_LINE = 11;

/**
 * The names standing round a node of `type` in `box` with `ports`, `unwired` those that want a wire,
 * as the canvas writes them (see nameOf). A node of a type this build does not know spreads its ports
 * along their sides, and their names with them; the routes leave those to the node's own margin.
 */
export function namesOf(box: Box, type: string, ports: Ports, unwired: readonly string[]): Box[] {
  if (!isNodeType(type)) return [];

  const named = ports.ins.length + ports.outs.length > 2;
  const middle = box.y + box.height / 2;
  const centre = box.x + box.width / 2;
  const place = (port: string, out: boolean): Box[] => {
    const text = nameOf(port, named, unwired.includes(port));
    if (text === '') return [];

    const width = text.length * NAME_CHAR;
    switch (sideOf(port, out)) {
      case 'right':
        return [{ x: box.x + box.width + MARGIN + 5, y: middle - 6 - NAME_LINE, width, height: NAME_LINE }];
      case 'left':
        return [{ x: box.x - MARGIN - 5 - width, y: middle - 6 - NAME_LINE, width, height: NAME_LINE }];
      case 'bottom':
        return [{ x: centre + 9, y: box.y + box.height + 2, width, height: NAME_LINE }];
      case 'top':
        return [{ x: centre + 9, y: box.y - 2 - NAME_LINE, width, height: NAME_LINE }];
    }
  };

  return [...ports.ins.flatMap((port) => place(port, false)), ...ports.outs.flatMap((port) => place(port, true))];
}

/**
 * A straight run of a wire already routed: level at `at`, from `lo` to `hi` across — or upright at
 * `at`, from `lo` to `hi` down. `into` is the port the wire goes into, and `approach` whether the run
 * is how it goes in, which the other wires into that port may share.
 */
type Run = { at: number; lo: number; hi: number; into: string; approach: boolean };

/** Whether two stretches have more than a touch in common. */
const overlap = (lo: number, hi: number, from: number, to: number) => Math.min(hi, to) - Math.max(lo, from) > 0.5;

/** Whether a wire at `at` runs closer than STACK beside another at `other`: a hair under it is as far, as sums in floating point come out. */
const beside = (at: number, other: number) => Math.abs(at - other) < STACK - 0.001;

/**
 * How many times a lane or a run up and down moves on past what stands in its way, at the most. Each
 * thing in the way moves it once, past it, so it settles long before; the bound is for a sum in
 * floating point that would otherwise put it back where it was.
 */
const MOVES = 1000;

/**
 * Where every wire of `legs` that is drawn round runs, by its id, round `nodes` and the names beside
 * them. A wire that goes forward, or one with an end on a node not yet measured, has none: the canvas
 * draws it as the curve.
 */
export function routes(nodes: readonly Placed[], legs: readonly Leg[]): Map<string, Route> {
  const boxes = new Map(nodes.map((node) => [node.id, node.box]));
  const names = nodes.flatMap((node) => node.names);
  const levels: Run[] = [];
  const uprights: Run[] = [];
  const found = new Map<string, Route>();

  /** The lowest lane at `y` or above it, along lo..hi, clear of every node, name and lane there. */
  const laneUp = (start: number, lo: number, hi: number) => {
    let y = start;
    for (let moved = true, count = 0; moved && count < MOVES; count++) {
      moved = false;
      for (const { box } of nodes)
        if (overlap(lo, hi, box.x, box.x + box.width) && y > box.y - OVER && y < box.y + box.height + MARGIN) {
          y = box.y - OVER;
          moved = true;
        }
      for (const name of names)
        if (overlap(lo, hi, name.x, name.x + name.width) && y > name.y - NAME_ROOM && y < name.y + name.height + NAME_ROOM) {
          y = name.y - NAME_ROOM;
          moved = true;
        }
      for (const run of levels)
        if (overlap(lo, hi, run.lo, run.hi) && beside(y, run.at)) {
          y = run.at - STACK;
          moved = true;
        }
    }
    return y;
  };

  /** The highest lane at `y` or under it, along lo..hi, clear of every node, name and lane there. */
  const laneDown = (start: number, lo: number, hi: number) => {
    let y = start;
    for (let moved = true, count = 0; moved && count < MOVES; count++) {
      moved = false;
      for (const { box } of nodes)
        if (overlap(lo, hi, box.x, box.x + box.width) && y > box.y - OVER && y < box.y + box.height + MARGIN) {
          y = box.y + box.height + MARGIN;
          moved = true;
        }
      for (const name of names)
        if (overlap(lo, hi, name.x, name.x + name.width) && y > name.y - NAME_ROOM && y < name.y + name.height + NAME_ROOM) {
          y = name.y + name.height + NAME_ROOM;
          moved = true;
        }
      for (const run of levels)
        if (overlap(lo, hi, run.lo, run.hi) && beside(y, run.at)) {
          y = run.at + STACK;
          moved = true;
        }
    }
    return y;
  };

  /**
   * The first place at `x` or past it, going `way` — 1 right, −1 left — where a wire can run up or
   * down from `a` to `b` clear of every node, name and other wire running so. A wire into `into` may
   * come down where another one into it comes down.
   */
  const column = (start: number, a: number, b: number, way: 1 | -1, into?: string) => {
    const [lo, hi] = [Math.min(a, b), Math.max(a, b)];
    let x = start;
    for (let moved = true, count = 0; moved && count < MOVES; count++) {
      moved = false;
      for (const { box } of nodes)
        if (overlap(lo, hi, box.y, box.y + box.height) && x > box.x - MARGIN && x < box.x + box.width + MARGIN) {
          x = way > 0 ? box.x + box.width + MARGIN : box.x - MARGIN;
          moved = true;
        }
      for (const name of names)
        if (overlap(lo, hi, name.y, name.y + name.height) && x > name.x - NAME_ROOM && x < name.x + name.width + NAME_ROOM) {
          x = way > 0 ? name.x + name.width + NAME_ROOM : name.x - NAME_ROOM;
          moved = true;
        }
      for (const run of uprights)
        if (!(run.approach && run.into === into) && overlap(lo, hi, run.lo, run.hi) && beside(x, run.at)) {
          x = run.at + way * STACK;
          moved = true;
        }
    }
    return x;
  };

  /** Whether a route runs clear of every node — but its own two, where it leaves the one and goes into the other. */
  const clear = (leg: Leg, route: Route) => {
    const points = pointsOf(leg.source, leg.target, route);
    return points.slice(1).every((to, at) => {
      const from = points[at];
      return nodes.every(({ id, box }) => {
        if ((at === 0 && id === leg.from) || (at === points.length - 2 && id === leg.to)) return true;
        const level = from.y === to.y;
        return level
          ? !(from.y > box.y && from.y < box.y + box.height && Math.max(from.x, to.x) > box.x && Math.min(from.x, to.x) < box.x + box.width)
          : !(from.x > box.x && from.x < box.x + box.width && Math.max(from.y, to.y) > box.y && Math.min(from.y, to.y) < box.y + box.height);
      });
    });
  };

  const climb = (leg: Leg, from: Box, to: Box): Route => {
    const { source, target } = leg;
    const foot = source.side === 'bottom';
    const onto = target.side === 'top';
    const into = `${leg.to}:${leg.toPort}`;
    let rise = from.x + from.width + MARGIN;
    let drop = onto ? target.x : target.x - MARGIN;
    // Over the node it leaves, which the lane runs back over; and over a loop it comes down onto.
    let lane = Math.min(from.y, onto ? to.y : Infinity) - OVER;
    // Out of a foot it runs under its node to where it rises, kept clear as a lane is: at the margin
    // under the foot it ran beside the lane of a wire passing under the same node, four pixels off.
    let below = foot ? source.y + MARGIN : null;

    for (let round = 0; round < ROUNDS; round++) {
      lane = laneUp(lane, Math.min(rise, drop), Math.max(rise, drop));
      if (foot) below = laneDown(source.y + MARGIN, Math.min(source.x, rise), Math.max(source.x, rise));
      const r = column(rise, lane, below ?? source.y, 1);
      const d = onto ? drop : column(drop, lane, target.y, -1, into);
      if (r === rise && d === drop) break;
      [rise, drop] = [r, d];
    }

    const route = { rise, below, lane, drop };
    if (!onto || clear(leg, route)) return route;

    // A next comes down from straight above it, and the lane's height cannot help when a node stands
    // over the loop, right where the wire comes down: from any height it comes down through that
    // node. The one way onto the next is through the gap under it, so the wire goes along the middle
    // of that gap, as far from both as it can be, if it can get there.
    const over = nodes
      .filter(({ box }) => box.x < target.x && target.x < box.x + box.width && box.y + box.height <= to.y && box.y + box.height > lane)
      .reduce((lowest, { box }) => Math.max(lowest, box.y + box.height), -Infinity);
    if (over === -Infinity) return route;

    const middle = (over + to.y) / 2;
    const squeezed = { rise: column(from.x + from.width + MARGIN, middle, below ?? source.y, 1), below, lane: middle, drop };
    return clear(leg, squeezed) ? squeezed : route;
  };

  /** Under the node it leaves, along, and into a way in: going left (`descends`) or right (`rises`). Null when there is no such way. */
  const under = (leg: Leg, from: Box, to: Box, way: 'descends' | 'rises'): Route | null => {
    const { source, target } = leg;
    const foot = source.side === 'bottom';
    const onto = target.side === 'top';
    const into = `${leg.to}:${leg.toPort}`;
    let rise = foot ? null : from.x + from.width + MARGIN;
    let drop = onto ? target.x : target.x - MARGIN;
    let lane = from.y + from.height + MARGIN;

    for (let round = 0; round < ROUNDS; round++) {
      const x = rise ?? source.x;
      lane = laneDown(lane, Math.min(x, drop), Math.max(x, drop));
      const r = rise === null ? null : column(rise, source.y, lane, 1);
      const d = onto ? drop : column(drop, lane, target.y, -1, into);
      if (r === rise && d === drop) break;
      [rise, drop] = [r, d];
    }

    // Onto a next it comes down from over the loop; and going right it comes up to the way in from
    // its left, past the foot it left.
    if (onto && lane > to.y - OVER) return null;
    if (way === 'rises' && drop - source.x < MARGIN) return null;
    return { rise, below: null, lane, drop };
  };

  const order = (leg: Leg, way: Way, from: Box) => {
    const rise = way === 'climbs' || leg.source.side !== 'bottom' ? from.x + from.width + MARGIN : leg.source.x;
    const drop = leg.target.side === 'top' ? leg.target.x : leg.target.x - MARGIN;
    return { turn: way === 'descends' ? 0 : way === 'climbs' ? 1 : 2, span: Math.round(Math.abs(rise - drop)), out: leg.source.y };
  };

  const todo = legs
    .flatMap((leg) => {
      const way = wayOf(leg.source, leg.target);
      const from = boxes.get(leg.from);
      const to = boxes.get(leg.to);
      return way === 'forward' || !from || !to ? [] : [{ leg, way, from, to, ...order(leg, way, from) }];
    })
    // What goes down to a node further left first: it turns down beside the node it leaves, inside
    // anything rising past there. Then what climbs, and last what runs right under a row and up: along
    // under the whole row, it passes under the short runs of what climbs out of the feet there, not
    // between them and the feet. Each the narrowest first, and of two as wide the one leaving higher,
    // which has the shorter way up: the wire out of a foot goes round the one beside it.
    .sort((a, b) => a.turn - b.turn || a.span - b.span || a.out - b.out || (a.leg.id < b.leg.id ? -1 : a.leg.id > b.leg.id ? 1 : 0));

  for (const { leg, way, from, to } of todo) {
    let route: Route | null;
    if (way === 'climbs') route = climb(leg, from, to);
    else {
      route = under(leg, from, to, way);
      // Down to a next with no room over it, or with no clear way under: a wire going down climbs over
      // instead. One going right with no room to come up beside its way in, or no clear way to it, is
      // the curve after all.
      if (route !== null && !clear(leg, route)) route = null;
      if (route === null && way === 'descends') route = climb(leg, from, to);
    }
    if (route === null) continue;

    found.set(leg.id, route);
    const into = `${leg.to}:${leg.toPort}`;
    const points = pointsOf(leg.source, leg.target, route);
    const going = leg.target.side === 'top' ? 1 : 2;
    for (let at = 1; at < points.length; at++) {
      const [a, b] = [points[at - 1], points[at]];
      const approach = at > points.length - 1 - going;
      if (a.y === b.y) levels.push({ at: a.y, lo: Math.min(a.x, b.x), hi: Math.max(a.x, b.x), into, approach });
      else uprights.push({ at: a.x, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y), into, approach });
    }
  }

  return found;
}

/**
 * The corners of a wire's route from `source` to `target`, each run straight: out of a way out on the
 * right to `rise`, or down out of a foot — straight to the lane, or to `below` first and across to
 * `rise` — then up or down to `lane`, along it, and onto a next from straight above or down beside a
 * way in, at `drop`, and into it.
 */
export function pointsOf(source: End, target: End, { rise, below, lane, drop }: Route): Point[] {
  const down = below ?? source.y + MARGIN;
  const out: Point[] =
    source.side !== 'bottom'
      ? [{ x: rise ?? source.x, y: source.y }, { x: rise ?? source.x, y: lane }]
      : rise === null
        ? [{ x: source.x, y: lane }]
        : [{ x: source.x, y: down }, { x: rise, y: down }, { x: rise, y: lane }];
  const into: Point[] = target.side === 'top' ? [{ x: target.x, y: lane }] : [{ x: drop, y: lane }, { x: drop, y: target.y }];

  // A point where the wire does not turn is no corner: two in one place, or one on the line between
  // its neighbours, as a lane at the height of the way it goes into makes.
  const points = [source, ...out, ...into, target].filter(
    (point, at, all) => at === 0 || point.x !== all[at - 1].x || point.y !== all[at - 1].y,
  );
  return points.filter((point, at, all) => {
    if (at === 0 || at === all.length - 1) return true;
    const [before, after] = [all[at - 1], all[at + 1]];
    return !((before.x === point.x && point.x === after.x) || (before.y === point.y && point.y === after.y));
  });
}

/** A point `by` along the line from `from` towards `to`. */
function toward(from: Point, to: Point, by: number): Point {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  return length === 0 ? from : { x: from.x + ((to.x - from.x) * by) / length, y: from.y + ((to.y - from.y) * by) / length };
}

/** A path through the points, straight from one to the next, each corner rounded. */
function rounded(points: readonly Point[]): string {
  let path = `M${points[0].x},${points[0].y}`;

  for (let at = 1; at < points.length - 1; at++) {
    const [before, corner, after] = [points[at - 1], points[at], points[at + 1]];
    // No more than half of either side, so two corners close together never overlap.
    const radius = Math.min(
      CORNER,
      Math.hypot(corner.x - before.x, corner.y - before.y) / 2,
      Math.hypot(after.x - corner.x, after.y - corner.y) / 2,
    );
    const into = toward(corner, before, radius);
    const out = toward(corner, after, radius);
    path += ` L${into.x},${into.y} Q${corner.x},${corner.y} ${out.x},${out.y}`;
  }

  const last = points[points.length - 1];
  return `${path} L${last.x},${last.y}`;
}

/** The path of a wire drawn round, from its way out to its way in, along its route. */
export function backPath({ source, target, ...route }: { source: End; target: End } & Route): string {
  return rounded(pointsOf(source, target, route));
}
