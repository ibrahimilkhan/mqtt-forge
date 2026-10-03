import { getBezierPath, Position } from '@xyflow/react';
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
 * the step after it on the row — an If's no to the End, past the step on its yes.
 *
 * Every other wire stays the curve — but for one whose curve would run through a node or a port's
 * name on its way, which goes round too. A node put on a loop's done stands a row under the loop, and
 * the curve from it up to the End at the end of the row cut the corner of the body's last step; a
 * reader can drag a node anywhere, into any curve's way.
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
 * Those are the routes a reader draws by hand, and each is checked whole once it is worked out: the
 * short runs out of a port and into one were never looked at, and a way in whose drop was pushed left
 * past a node on its row went into it through that node. A route that does not run clear is traced
 * instead (trace): the shortest way with the fewest turns through the gaps between the nodes, which a
 * flowchart always has, round everything if need be.
 *
 * The narrowest are worked out first, so a loop inside another has its return under the outer one's —
 * nested, the two never cross — and what runs along under a row after what climbs out of it (see the
 * order in routes); the curves that would run through something last, round what is drawn by then.
 */

/** How far past its node a wire turns up or down, how far left of a way in it comes down, and how far under a node a lane runs. */
export const MARGIN = 24;

/** How far above the nodes it runs over a lane runs. */
const OVER = 32;

/** How far apart two wires run beside each other. */
const STACK = 16;

/** How far clear of a port's name a wire keeps. */
export const NAME_ROOM = 4;

/** The corners' radius. */
const CORNER = 8;

/**
 * Enough rounds of moving a lane and the runs up and down to it for any one wire: each round only
 * moves them on past what was in the way, so they settle in a few.
 */
const ROUNDS = 24;

/**
 * How near a node and a port's name a wire may come at the very least: what it may not run inside.
 * A route keeps its margins where it can; through a gap a reader left narrower than two of them, it
 * runs where there is room, and this keeps it off the frame.
 */
const CLEAR = 3;
const NAME_CLEAR = 2;

/** How near a node a traced wire runs when it squeezes past it: half a gap 16 wide. */
const TIGHT = 8;

/**
 * What a turn costs a traced wire, as so much more length: a route with one more corner reads as one
 * more thing to follow, and one 48 longer does not. And what running inside a node's margins, and
 * crossing another wire drawn round, cost on top of the length.
 */
const BEND = 48;
const HUG = 1;
const CROSSING = 12;

/**
 * What running through the mouth of another port costs a traced wire, on top of its length, for each
 * pixel of it (see throatOf): enough that it goes round a mouth wherever it can, and through one only
 * where there is no other way — two ports facing each other across a gap share theirs.
 */
const MOUTH = 6;

/**
 * How far round its two ends a traced wire looks for its way, before it looks further: most go round
 * a node or two near them, and the whole canvas is far more to search on every frame of a drag.
 */
const REACHES = [240, 720, Infinity];

/** The most places a trace searches over the whole canvas: a flow past that is drawn as best the routes above can. */
const PLACES = 250_000;

export type Point = { x: number; y: number };

/** Where a node stands on the canvas and how big it is drawn, or where a port's name stands. */
export type Box = { x: number; y: number; width: number; height: number };

/** A port's end, as React Flow puts it: where a wire meets it, and the side of its node it stands on. */
export type End = Point & { side: Side };

/** A node, as the routes go round it: its box, and the names of its ports beside it. */
export type Placed = { id: string; box: Box; names: readonly Box[] };

/** A wire, as the routes take it: the nodes it joins, the port it goes into, and its two ends. */
export type Leg = { id: string; from: string; to: string; toPort: string; source: End; target: End };

/** Where a wire drawn round runs: the corners it turns at, in order, from its way out to its way in. */
export type Route = readonly Point[];

/**
 * A route as a reader draws one: out of a way out at a node's foot down to `below`, along it under the
 * node, and up at `rise` — or out of one on the right to `rise` and up or down — or, `rise` null,
 * straight down out of its foot; then along `lane`, and down or up into a way in at `drop`. Onto a
 * next it comes down at the next. `below` is null but for a wire out of a foot that turns at `rise`.
 */
type Shape = { rise: number | null; below: number | null; lane: number; drop: number };

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
 * is how it goes in, which the other wires into that port may share. A run with a `leg` is that wire's
 * stub, held for it from the start (see stubsOf): every other wire keeps off it as off a run drawn.
 */
type Run = { at: number; lo: number; hi: number; into: string; approach: boolean; leg?: string };

/** What no wire may run inside, its edges left open so a wire may run along one: a node or a name, with what it keeps clear round it. */
type Rect = { x1: number; y1: number; x2: number; y2: number };

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
 * How many times the routes are worked out at the most: once, and again with the wires that found no
 * clear way put first, while that leaves fewer of them.
 */
const PLANS = 3;

/**
 * Where every wire of `legs` that is drawn round runs, by its id, round `nodes` and the names beside
 * them. A wire whose curve runs clear, or one with an end on a node not yet measured, has none: the
 * canvas draws it as the curve.
 *
 * Each wire goes round the wires worked out before it, so one worked out late can find its way taken:
 * the curve out of a step traced last found a return rising just past its port and another running
 * along just past that, and no way out between them. So the routes are worked out again with the wires
 * that found no clear way first, and the others round them; the plan kept is the one that left the
 * fewest such wires. A drawing with none, which is nearly all of them, is worked out once.
 */
export function routes(nodes: readonly Placed[], legs: readonly Leg[]): Map<string, Route> {
  // The curves that would run through a node or a name, whatever the plan: each is traced.
  const boxes = new Map(nodes.map((node) => [node.id, node.box]));
  const kept = {
    nodes: nodes.map(({ id, box }) => ({ id, rect: around(box, CLEAR) })),
    names: nodes.flatMap((node) => node.names).map((name) => around(name, NAME_CLEAR)),
  };
  const curved = new Set(
    legs
      .filter((leg) => wayOf(leg.source, leg.target) === 'forward' && boxes.has(leg.from) && boxes.has(leg.to) && !curveRunsClear(leg, kept))
      .map((leg) => leg.id),
  );

  let first: string[] = [];
  let best: Plan | null = null;
  for (let round = 0; round < PLANS; round++) {
    const made = plan(nodes, legs, curved, first);
    if (best === null || made.stuck.length < best.stuck.length) best = made;
    if (made.stuck.length === 0) break;
    first = [...first, ...made.stuck.filter((id) => !first.includes(id))];
  }
  return best!.found;
}

/** The routes worked out once, and the wires that found no clear way: drawn the curve, or a way that runs through something. */
type Plan = { found: Map<string, Route>; stuck: string[] };

/** The routes worked out with the wires of `first` before the rest, in that order; `curved` those going forward whose curve would run through something. */
function plan(nodes: readonly Placed[], legs: readonly Leg[], curved: ReadonlySet<string>, first: readonly string[]): Plan {
  const boxes = new Map(nodes.map((node) => [node.id, node.box]));
  const names = nodes.flatMap((node) => node.names);
  // Every wire's stubs are held from the start, its own wire's to run on, and every other's to keep
  // off: a wire going down to a way in on the left came down beside the foot of the node it left, a
  // pixel from where that foot's own wire comes out, and the foot's wire had no way out at all.
  const stubs = legs.flatMap(stubsOf);
  const levels: Run[] = stubs.filter(({ level }) => level).map(({ run }) => run);
  const uprights: Run[] = stubs.filter(({ level }) => !level).map(({ run }) => run);
  const found = new Map<string, Route>();
  /** The wire being worked out, which runs on its own stubs. */
  let owner = '';
  const others = (run: Run) => run.leg !== owner;

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
        if (others(run) && overlap(lo, hi, run.lo, run.hi) && beside(y, run.at)) {
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
        if (others(run) && overlap(lo, hi, run.lo, run.hi) && beside(y, run.at)) {
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
        if (others(run) && !(run.approach && run.into === into) && overlap(lo, hi, run.lo, run.hi) && beside(x, run.at)) {
          x = run.at + way * STACK;
          moved = true;
        }
    }
    return x;
  };

  /**
   * What a wire may not run inside: every node with CLEAR round it, and every name with NAME_CLEAR.
   * Its own two nodes too — a wire that ran back through the node it left would read as going nowhere
   * — but for the line out of its port, and into the other: the parallelogram's ports stand inside its
   * box, on its slanted sides. Only that line: with the side cut off up to the port, a wire could run
   * up or down inside the box, beside the slant.
   */
  const blocksOf = (leg: Leg): Rect[] => [
    ...nodes.flatMap(({ id, box }) => {
      let rects = [around(box, CLEAR)];
      if (id === leg.from) rects = rects.flatMap((rect) => opened(rect, leg.source));
      if (id === leg.to) rects = rects.flatMap((rect) => opened(rect, leg.target));
      return rects;
    }),
    ...names.map((name) => around(name, NAME_CLEAR)),
  ];

  /**
   * Whether a wire through `points` runs clear: through no node and no name (see blocksOf), and on no
   * other wire drawn round, nor beside one closer than STACK, but where it goes into the port another
   * one goes into, as that one goes in.
   */
  const free = (leg: Leg, points: readonly Point[], blocks: readonly Rect[]) => {
    const into = `${leg.to}:${leg.toPort}`;
    const going = leg.target.side === 'top' ? 1 : 2;

    return points.slice(1).every((to, at) => {
      const from = points[at];
      const level = from.y === to.y;
      const line = level ? from.y : from.x;
      const [lo, hi] = level ? [Math.min(from.x, to.x), Math.max(from.x, to.x)] : [Math.min(from.y, to.y), Math.max(from.y, to.y)];
      const inside = (rect: Rect) =>
        level ? line > rect.y1 && line < rect.y2 && hi > rect.x1 && lo < rect.x2 : line > rect.x1 && line < rect.x2 && hi > rect.y1 && lo < rect.y2;
      if (blocks.some(inside)) return false;

      const approach = at >= points.length - 1 - going;
      return !(level ? levels : uprights).some(
        (run) => others(run) && !(approach && run.approach && run.into === into) && overlap(lo, hi, run.lo, run.hi) && beside(line, run.at),
      );
    });
  };

  const climb = (leg: Leg, from: Box, to: Box, blocks: readonly Rect[]): Shape => {
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
    if (!onto || free(leg, shaped(source, target, route), blocks)) return route;

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
    return free(leg, shaped(source, target, squeezed), blocks) ? squeezed : route;
  };

  /** Under the node it leaves, along, and into a way in: going left (`descends`) or right (`rises`). Null when there is no such way. */
  const under = (leg: Leg, from: Box, to: Box, way: 'descends' | 'rises'): Shape | null => {
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

  /** A route kept, its runs from then on in the way of every wire worked out after it. */
  const keep = (leg: Leg, points: readonly Point[]) => {
    found.set(leg.id, points.slice(1, -1));
    const into = `${leg.to}:${leg.toPort}`;
    const going = leg.target.side === 'top' ? 1 : 2;
    for (let at = 1; at < points.length; at++) {
      const [a, b] = [points[at - 1], points[at]];
      const approach = at > points.length - 1 - going;
      if (a.y === b.y) levels.push({ at: a.y, lo: Math.min(a.x, b.x), hi: Math.max(a.x, b.x), into, approach });
      else uprights.push({ at: a.x, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y), into, approach });
    }
  };

  // In front of every port, the stretch its wire leaves or comes in by, which a traced wire keeps out
  // of where it can: one traced across under a foot and up beside it left that foot's own wire no way
  // to turn. Wires into one port come in by it together.
  const throats = legs.flatMap((leg) => [
    { leg: leg.id, into: null, rect: throatOf(leg.source, leaving[leg.source.side]) },
    { leg: leg.id, into: `${leg.to}:${leg.toPort}`, rect: throatOf(leg.target, arriving[leg.target.side] ^ 1) },
  ]);
  const traced = (leg: Leg, blocks: readonly Rect[]) => {
    const into = `${leg.to}:${leg.toPort}`;
    const mouths = throats.flatMap((throat) => (throat.leg === leg.id || throat.into === into ? [] : [throat.rect]));
    return trace(leg, blocks, mouths, nodes, names, levels.filter(others), uprights.filter(others));
  };

  const back = legs
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

  // The curves that would run through a node or a name, the narrowest first, after the rest: round what
  // is drawn by then.
  const crossing = legs
    .filter((leg) => curved.has(leg.id))
    .map((leg) => ({ leg, span: Math.abs(leg.target.x - leg.source.x) + Math.abs(leg.target.y - leg.source.y) }))
    .sort((a, b) => a.span - b.span || (a.leg.id < b.leg.id ? -1 : a.leg.id > b.leg.id ? 1 : 0));

  const going: Array<{ leg: Leg; way: Way; from: Box; to: Box }> = [
    ...back,
    ...crossing.map(({ leg }) => ({ leg, way: 'forward' as const, from: boxes.get(leg.from)!, to: boxes.get(leg.to)! })),
  ];
  const ahead = first.flatMap((id) => going.filter((one) => one.leg.id === id));
  const stuck: string[] = [];

  for (const { leg, way, from, to } of [...ahead, ...going.filter((one) => !first.includes(one.leg.id))]) {
    owner = leg.id;
    const blocks = blocksOf(leg);
    if (way === 'forward') {
      const points = traced(leg, blocks);
      if (points === null) stuck.push(leg.id);
      else keep(leg, points);
      continue;
    }

    // Down to a next with no room over it, or with no clear way under, a wire going down climbs over
    // instead; and so does one going right under its row with no room to come up beside its way in.
    // Drawn as the curve, that one went back through the node it left. When neither runs clear, the
    // wire is traced; and when not even that finds a way, it is drawn the first way after all.
    const ways = way === 'climbs' ? [() => climb(leg, from, to, blocks)] : [() => under(leg, from, to, way), () => climb(leg, from, to, blocks)];
    let tried: Point[] | null = null;
    let clear: Point[] | null = null;
    for (const shape of ways) {
      const made = shape();
      if (made === null) continue;
      const points = shaped(leg.source, leg.target, made);
      tried ??= points;
      if (free(leg, points, blocks)) {
        clear = points;
        break;
      }
    }
    const points = clear ?? traced(leg, blocks);
    if (points === null) stuck.push(leg.id);
    keep(leg, points ?? tried!);
  }

  return { found, stuck };
}

/** React Flow's name for each side of a node. */
export const POSITIONS: Record<Side, Position> = {
  left: Position.Left,
  right: Position.Right,
  top: Position.Top,
  bottom: Position.Bottom,
};

/**
 * Whether React Flow's curve for a wire runs clear of every node and every name, with what each keeps
 * clear round it, as the canvas draws the curve (getBezierPath), at a pixel a step. Its own two nodes
 * count too but where it leaves the one and goes into the other: its first and last ten pixels.
 */
function curveRunsClear(
  leg: Leg,
  kept: { nodes: ReadonlyArray<{ id: string; rect: Rect }>; names: readonly Rect[] },
): boolean {
  const { source, target } = leg;
  const [path] = getBezierPath({
    sourceX: source.x,
    sourceY: source.y,
    sourcePosition: POSITIONS[source.side],
    targetX: target.x,
    targetY: target.y,
    targetPosition: POSITIONS[target.side],
  });
  const [, , ax, ay, bx, by] = (path.match(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/g) ?? []).map(Number);

  // Only what stands round the curve can be in its way: it never leaves the box round its four points.
  const [x1, y1] = [Math.min(source.x, ax, bx, target.x), Math.min(source.y, ay, by, target.y)];
  const [x2, y2] = [Math.max(source.x, ax, bx, target.x), Math.max(source.y, ay, by, target.y)];
  const near: Array<{ rect: Rect; end: End | null }> = [];
  for (const { id, rect } of kept.nodes)
    if (rect.x1 < x2 && x1 < rect.x2 && rect.y1 < y2 && y1 < rect.y2) near.push({ rect, end: id === leg.from ? source : id === leg.to ? target : null });
  for (const rect of kept.names) if (rect.x1 < x2 && x1 < rect.x2 && rect.y1 < y2 && y1 < rect.y2) near.push({ rect, end: null });
  if (near.length === 0) return true;

  const reach = Math.hypot(ax - source.x, ay - source.y) + Math.hypot(bx - ax, by - ay) + Math.hypot(target.x - bx, target.y - by);
  const count = Math.max(1, Math.ceil(reach));
  for (let step = 0; step <= count; step++) {
    const t = step / count;
    const u = 1 - t;
    const x = u * u * u * source.x + 3 * u * u * t * ax + 3 * u * t * t * bx + t * t * t * target.x;
    const y = u * u * u * source.y + 3 * u * u * t * ay + 3 * u * t * t * by + t * t * t * target.y;
    for (const { rect, end } of near)
      if (x > rect.x1 && x < rect.x2 && y > rect.y1 && y < rect.y2 && (end === null || Math.hypot(x - end.x, y - end.y) >= 10)) return false;
  }
  return true;
}

/** How far in front of a port its throat reaches, and how far either side of the wire through it. */
const THROAT = MARGIN + STACK;
const THROAT_SIDE = STACK - 1;

/** The stretch in front of a port at `end`, out from it the way `heading` goes. */
function throatOf(end: End, heading: number): Rect {
  const { x: dx, y: dy } = STEPS[heading];
  const [a, b] = [end, { x: end.x + dx * THROAT, y: end.y + dy * THROAT }];
  return dx !== 0
    ? { x1: Math.min(a.x, b.x), x2: Math.max(a.x, b.x), y1: end.y - THROAT_SIDE, y2: end.y + THROAT_SIDE }
    : { x1: end.x - THROAT_SIDE, x2: end.x + THROAT_SIDE, y1: Math.min(a.y, b.y), y2: Math.max(a.y, b.y) };
}

/**
 * A wire's stubs: its first MARGIN out of its way out, and its last into its way in, which the wires
 * into the same port share as they go in together.
 */
function stubsOf(leg: Leg): Array<{ level: boolean; run: Run }> {
  const stub = (end: End, heading: number, into: string, approach: boolean) => {
    const { x: dx, y: dy } = STEPS[heading];
    const [a, b] = dx !== 0 ? [end.x, end.x + dx * MARGIN] : [end.y, end.y + dy * MARGIN];
    return { level: dx !== 0, run: { at: dx !== 0 ? end.y : end.x, lo: Math.min(a, b), hi: Math.max(a, b), into, approach, leg: leg.id } };
  };
  return [
    stub(leg.source, leaving[leg.source.side], `${leg.id}:out`, false),
    stub(leg.target, arriving[leg.target.side] ^ 1, `${leg.to}:${leg.toPort}`, true),
  ];
}

/** A box with `by` kept clear round it. */
const around = (box: Box, by: number): Rect => ({ x1: box.x - by, y1: box.y - by, x2: box.x + box.width + by, y2: box.y + box.height + by });

/**
 * A wire's own node, as what the wire may not run inside, with the line out of its port at `end` left
 * open through it: the part on the far side of the port, and the two beside the port's line.
 */
function opened(rect: Rect, end: End): Rect[] {
  const level = end.side === 'left' || end.side === 'right';
  if (level ? end.y <= rect.y1 || end.y >= rect.y2 : end.x <= rect.x1 || end.x >= rect.x2) return [rect];

  const [beforeLine, afterLine] = level
    ? [{ ...rect, y2: end.y - 0.5 }, { ...rect, y1: end.y + 0.5 }]
    : [{ ...rect, x2: end.x - 0.5 }, { ...rect, x1: end.x + 0.5 }];
  switch (end.side) {
    case 'right':
      return [{ ...rect, x2: Math.min(rect.x2, end.x - 0.5) }, { ...beforeLine, x1: end.x - 0.5 }, { ...afterLine, x1: end.x - 0.5 }];
    case 'left':
      return [{ ...rect, x1: Math.max(rect.x1, end.x + 0.5) }, { ...beforeLine, x2: end.x + 0.5 }, { ...afterLine, x2: end.x + 0.5 }];
    case 'bottom':
      return [{ ...rect, y2: Math.min(rect.y2, end.y - 0.5) }, { ...beforeLine, y1: end.y - 0.5 }, { ...afterLine, y1: end.y - 0.5 }];
    case 'top':
      return [{ ...rect, y1: Math.max(rect.y1, end.y + 0.5) }, { ...beforeLine, y2: end.y + 0.5 }, { ...afterLine, y2: end.y + 0.5 }];
  }
}

/** The headings a traced wire runs in: right, left, down, up. */
const STEPS = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];

/** The heading a wire leaves a port on `side` in, and the one it arrives at a port on `side` in. */
const leaving: Record<Side, number> = { right: 0, left: 1, bottom: 2, top: 3 };
const arriving: Record<Side, number> = { left: 0, right: 1, top: 2, bottom: 3 };

/**
 * The way a wire takes through the gaps between the nodes when the route a reader would draw does not
 * run clear: out of its port the way the port faces, along the lines a reader would run it — a lane
 * over or under a node, a run up or down beside one, beside another wire 16 off, or the middle of a
 * gap too narrow for its margins — and into its port the way the port faces, at the least cost: its
 * length, a turn as BEND more, a stretch inside a node's margins as long again, and a wire drawn round
 * crossed as CROSSING. Through no node and no name (`blocks`), and on no other wire but where they go
 * into one port together, as free asks. The points it turns at, its two ends with them; null when
 * there is no such way.
 *
 * It looks near the two ends first (REACHES): within that, the lines are those of what stands there,
 * and the edge of where it looks, to go round what crosses it.
 */
function trace(
  leg: Leg,
  blocks: readonly Rect[],
  mouths: readonly Rect[],
  nodes: readonly Placed[],
  names: readonly Box[],
  levels: readonly Run[],
  uprights: readonly Run[],
): Point[] | null {
  for (const reach of REACHES) {
    const points = traceWithin(leg, reach, blocks, mouths, nodes, names, levels, uprights);
    if (points !== null) return points;
  }
  return null;
}

/**
 * One look for a wire's way, within `reach` of its two ends: what stands, runs and is held there, and
 * the way found among the same things before, when there was one.
 */
function traceWithin(
  leg: Leg,
  reach: number,
  allBlocks: readonly Rect[],
  allMouths: readonly Rect[],
  allNodes: readonly Placed[],
  allNames: readonly Box[],
  allLevels: readonly Run[],
  allUprights: readonly Run[],
): Point[] | null {
  const { source, target } = leg;
  const into = `${leg.to}:${leg.toPort}`;

  // Where it looks: round its two ends, or round everything there is. Only what stands there counts,
  // and its lines: a flow of two hundred nodes is far more than one wire needs to go round, worked out
  // again on every frame of a drag.
  const spans = [...allBlocks, ...allMouths];
  const low = {
    x: Number.isFinite(reach) ? Math.min(source.x, target.x) - reach : Math.min(source.x, target.x, ...spans.map((rect) => rect.x1)) - 2 * OVER,
    y: Number.isFinite(reach) ? Math.min(source.y, target.y) - reach : Math.min(source.y, target.y, ...spans.map((rect) => rect.y1)) - 2 * OVER,
  };
  const high = {
    x: Number.isFinite(reach) ? Math.max(source.x, target.x) + reach : Math.max(source.x, target.x, ...spans.map((rect) => rect.x2)) + 2 * OVER,
    y: Number.isFinite(reach) ? Math.max(source.y, target.y) + reach : Math.max(source.y, target.y, ...spans.map((rect) => rect.y2)) + 2 * OVER,
  };
  const within = (rect: Rect) => rect.x1 < high.x && low.x < rect.x2 && rect.y1 < high.y && low.y < rect.y2;
  const runWithin = (level: boolean) => (run: Run) =>
    level
      ? run.at > low.y - STACK && run.at < high.y + STACK && run.lo < high.x && low.x < run.hi
      : run.at > low.x - STACK && run.at < high.x + STACK && run.lo < high.y && low.y < run.hi;
  const blocks = allBlocks.filter(within);
  const nodes = allNodes.filter(({ box }) => within({ x1: box.x - OVER, y1: box.y - OVER, x2: box.x + box.width + OVER, y2: box.y + box.height + OVER }));
  const names = allNames.filter((name) => within({ x1: name.x - NAME_ROOM, y1: name.y - NAME_ROOM, x2: name.x + name.width + NAME_ROOM, y2: name.y + name.height + NAME_ROOM }));
  const levels = allLevels.filter(runWithin(true));
  const uprights = allUprights.filter(runWithin(false));
  const mouths = allMouths.filter(within);
  const zones = [
    ...nodes.map(({ box }) => ({ rect: { x1: box.x - MARGIN, y1: box.y - OVER, x2: box.x + box.width + MARGIN, y2: box.y + box.height + MARGIN }, weight: HUG })),
    ...mouths.map((rect) => ({ rect, weight: MOUTH })),
  ];

  // The same wire among the same things takes the same way: on a frame of a drag, only the wires near
  // the node dragged are traced again.
  const key = [
    reach, source.x, source.y, source.side, target.x, target.y, target.side, into,
    '|', ...blocks.flatMap((rect) => [rect.x1, rect.y1, rect.x2, rect.y2]),
    '|', ...mouths.flatMap((rect) => [rect.x1, rect.y1, rect.x2, rect.y2]),
    '|', ...nodes.flatMap(({ box }) => [box.x, box.y, box.width, box.height]),
    '|', ...names.flatMap((name) => [name.x, name.y, name.width, name.height]),
    '|', ...levels.flatMap((run) => [run.at, run.lo, run.hi, run.into, run.approach]),
    '|', ...uprights.flatMap((run) => [run.at, run.lo, run.hi, run.into, run.approach]),
  ].join(',');
  const known = traces.get(key);
  if (known !== undefined) return known;
  if (traces.size >= TRACES) traces.clear();
  const found = search(leg, { low, high }, blocks, zones, nodes, names, levels, uprights);
  traces.set(key, found);
  return found;
}

/**
 * The search itself, within `low`..`high` (see trace): the lines of what stands there, where each step
 * along them may go and what it costs, and the cheapest way over them from one port to the other.
 */
function search(
  leg: Leg,
  { low, high }: { low: Point; high: Point },
  blocks: readonly Rect[],
  zones: ReadonlyArray<{ rect: Rect; weight: number }>,
  nodes: readonly Placed[],
  names: readonly Box[],
  levels: readonly Run[],
  uprights: readonly Run[],
): Point[] | null {
  const { source, target } = leg;
  const into = `${leg.to}:${leg.toPort}`;

  const xs = [source.x, target.x, source.x + MARGIN, target.x - MARGIN];
  const ys = [source.y, target.y, source.y + MARGIN, target.y - MARGIN];
  for (const { box } of nodes) {
    const [right, bottom] = [box.x + box.width, box.y + box.height];
    xs.push(box.x - MARGIN, box.x - TIGHT, right + TIGHT, right + MARGIN);
    ys.push(box.y - OVER, box.y - TIGHT, bottom + TIGHT, bottom + MARGIN);
  }
  for (const name of names) {
    xs.push(name.x - NAME_ROOM, name.x + name.width + NAME_ROOM);
    ys.push(name.y - NAME_ROOM, name.y + name.height + NAME_ROOM);
  }
  for (const run of uprights) xs.push(run.at - STACK, run.at + STACK, ...(run.into === into ? [run.at] : []));
  for (const run of levels) ys.push(run.at - STACK, run.at + STACK);

  // Out of its port, and into the other, it may turn anywhere past its first CORNER and short of what
  // stands in its way: a line there, and one half-way along, let it turn when the lines of what stands
  // round leave none — a node put down just under a foot, the name of its next a few pixels under it.
  for (const [end, heading] of [
    [source, leaving[source.side]],
    [target, arriving[target.side] ^ 1],
  ] as const) {
    const { x: dx, y: dy } = STEPS[heading];
    const room = blocks.reduce((nearest, rect) => {
      const [along, lo, hi, from, to] = dx !== 0 ? [end.y, rect.y1, rect.y2, rect.x1, rect.x2] : [end.x, rect.x1, rect.x2, rect.y1, rect.y2];
      if (!(along > lo && along < hi)) return nearest;
      const start = dx !== 0 ? end.x : end.y;
      const ahead = dx + dy > 0 ? from - start : start - to;
      return ahead >= 0 ? Math.min(nearest, ahead) : nearest;
    }, Infinity);
    if (room <= CORNER) continue;
    const reachable = Math.min(room, 4 * MARGIN);
    for (const by of [CORNER, (CORNER + reachable) / 2]) (dx !== 0 ? xs : ys).push((dx !== 0 ? end.x : end.y) + (dx + dy) * by);
  }

  // The lines, and one round the edge of where it looks, to go round what the edge crosses.
  const across = lines([...xs, low.x, high.x], low.x, high.x, [source.x, target.x]);
  const down = lines([...ys, low.y, high.y], low.y, high.y, [source.y, target.y]);
  const [nx, ny] = [across.length, down.length];
  if (nx * ny > PLACES) return null;

  // What each step along a line costs, and Infinity where it may not go: along each level line from
  // one place to the next, and down each upright one. On no other wire's runs — not even where they
  // go into its own port, which only its last runs may share (see wayIn) — and, for those last runs,
  // with the runs into its own port let be. Each line is worked out when the search first comes to
  // it: most of them it never does.
  const stepsOf = (sharing: boolean) => {
    const sharedInto = sharing ? into : null;
    const rows: Array<Float64Array | undefined> = [];
    const columns: Array<Float64Array | undefined> = [];
    return {
      level: (i: number, j: number) => (rows[j] ??= costs(down[j], across, blocks, zones, levels, uprights, sharedInto, 'y'))[i],
      upright: (i: number, j: number) => (columns[i] ??= costs(across[i], down, blocks, zones, uprights, levels, sharedInto, 'x'))[j],
    };
  };
  const steps = stepsOf(false);

  const [si, sj, ti, tj] = [across.indexOf(source.x), down.indexOf(source.y), across.indexOf(target.x), down.indexOf(target.y)];
  // Two ends a hair apart across one way have one line between them, and the trace one of them.
  if (si < 0 || sj < 0 || ti < 0 || tj < 0) return null;
  const start = si + nx * sj;
  const goal = ti + nx * tj;
  const [out, home] = [leaving[source.side], arriving[target.side]];

  // Where it may turn: not in its first CORNER, which the rounding of the corner takes, so it leaves
  // its port the way the port faces.
  const turnable = (place: number) => {
    const [x, y] = [across[place % nx], down[Math.floor(place / nx)]];
    return !(Math.abs(x - source.x) + Math.abs(y - source.y) < CORNER && (x === source.x || y === source.y));
  };

  // Its way in: into a way in on the left, down or up a line at least CORNER left of it to its height,
  // and along into it; onto a next, down onto it from at least CORNER above. These last runs may lie
  // on those of the wires already into the same port, as they come down to it and go in together.
  const shared = stepsOf(true);
  const wayIn = wayInto(home, ti, tj, ny, across, down, target, shared);

  const { spent, came } = searching(nx * ny * 4);
  const queue = new Queue();
  // What is left at the least: the way there, and a turn for each it cannot do without — going the way
  // it goes in but off the line it goes in by, or the other way, two; any other way, one.
  const guess = (place: number, heading: number) => {
    const [x, y] = [across[place % nx], down[Math.floor(place / nx)]];
    const { x: hx, y: hy } = STEPS[home];
    const short = (target.x - x) * hx + (target.y - y) * hy > 0 && (hx !== 0 ? y === target.y : x === target.x);
    const turns = heading === home ? (short ? 0 : 2) : heading === (home ^ 1) ? 2 : 1;
    return Math.abs(x - target.x) + Math.abs(y - target.y) + turns * BEND;
  };
  const arrived = goal * 4 + home;
  spent[start * 4 + out] = 0;
  queue.push(guess(start, out), start * 4 + out);

  while (queue.size > 0) {
    const state = queue.pop();
    if (state === arrived) {
      const last = came[state] >> 2;
      return cornersOnly([...placesOf(came[state], came, across, down, nx), ...wayIn.points(last % nx, Math.floor(last / nx)), target]);
    }

    const [place, heading] = [state >> 2, state & 3];
    if (place === goal) continue;

    const [i, j] = [place % nx, Math.floor(place / nx)];
    const final = wayIn.cost(i, j, heading, turnable(place));
    if (spent[state] + final < spent[arrived]) {
      spent[arrived] = spent[state] + final;
      came[arrived] = state;
      queue.push(spent[arrived], arrived);
    }

    for (let next = 0; next < 4; next++) {
      if ((next ^ 1) === heading) continue;
      const turning = next !== heading;
      if (turning && !turnable(place)) continue;

      const [ni, nj] = [i + STEPS[next].x, j + STEPS[next].y];
      if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
      const there = ni + nx * nj;
      const step = next < 2 ? steps.level(Math.min(i, ni), j) : steps.upright(i, Math.min(j, nj));
      if (!Number.isFinite(step) || there === start || there === goal) continue;

      // A turn straight after another, closer than two corners take, is a jog: the two roundings eat
      // the run between them, and what is left reads as a kink.
      const back = came[state];
      const jog = turning && back !== -1 && (back & 3) !== heading && Math.abs(across[i] - across[(back >> 2) % nx]) + Math.abs(down[j] - down[Math.floor((back >> 2) / nx)]) < 2 * CORNER;
      const cost = spent[state] + step + (turning ? BEND : 0) + (jog ? 2 * BEND : 0);
      const reached = there * 4 + next;
      if (cost < spent[reached]) {
        spent[reached] = cost;
        came[reached] = state;
        queue.push(cost + guess(there, next), reached);
      }
    }
  }

  return null;
}

/**
 * What a search keeps for each place and heading — what the way there cost, and the state it came
 * from — in arrays kept from one search to the next rather than made new for each: a frame of a drag
 * can trace tens of wires.
 */
let buffers = { spent: new Float64Array(0), came: new Int32Array(0) };
function searching(states: number) {
  if (buffers.spent.length < states) buffers = { spent: new Float64Array(states), came: new Int32Array(states) };
  return { spent: buffers.spent.subarray(0, states).fill(Infinity), came: buffers.came.subarray(0, states).fill(-1) };
}

/**
 * The traces worked out lately, by everything each was worked out from (see traceWithin), and how
 * many it keeps before it lets them all go.
 */
const traces = new Map<string, Point[] | null>();
const TRACES = 4096;

/**
 * A trace's way into its port at (ti, tj), heading `home`, by the steps that may share the runs into
 * the port: what it costs from each place and heading — Infinity where there is none — and the
 * points it turns at on the way.
 */
function wayInto(
  home: number,
  ti: number,
  tj: number,
  ny: number,
  across: readonly number[],
  down: readonly number[],
  target: Point,
  shared: { level: (i: number, j: number) => number; upright: (i: number, j: number) => number },
) {
  // How far up and down each line it can run clear to the port's height, and along that height into it.
  const reach = (i: number) => {
    let [top, bottom] = [tj, tj];
    while (top > 0 && Number.isFinite(shared.upright(i, top - 1))) top--;
    while (bottom < ny - 1 && Number.isFinite(shared.upright(i, bottom))) bottom++;
    return { top, bottom };
  };
  const side = home === 0;
  let first = ti;
  if (side) while (first > 0 && Number.isFinite(shared.level(first - 1, tj))) first--;
  const columns = new Map<number, { top: number; bottom: number }>();
  if (side) {
    for (let i = first; i < ti; i++) if (across[i] <= target.x - CORNER) columns.set(i, reach(i));
  } else columns.set(ti, reach(ti));

  return {
    cost(i: number, j: number, heading: number, turnable: boolean): number {
      const column = columns.get(i);
      if (column === undefined || j < column.top || j > column.bottom) return Infinity;
      if (!side) {
        if (down[j] > target.y - CORNER || heading === 3) return Infinity;
        return target.y - down[j] + (heading === 2 ? 0 : turnable ? BEND : Infinity);
      }
      const along = target.x - across[i];
      if (j === tj) return heading === 0 ? along : heading === 1 || !turnable ? Infinity : along + BEND;
      const way = j < tj ? 2 : 3;
      if (heading === (way ^ 1)) return Infinity;
      return Math.abs(target.y - down[j]) + along + BEND + (heading === way ? 0 : turnable ? BEND : Infinity);
    },
    points(i: number, j: number): Point[] {
      return side && j !== tj ? [{ x: across[i], y: target.y }] : [];
    },
  };
}

/** The places of the states a trace came by, from its start to `state`. */
function placesOf(state: number, came: Int32Array, across: readonly number[], down: readonly number[], nx: number): Point[] {
  const places: Point[] = [];
  for (let at = state; at !== -1; at = came[at]) places.push({ x: across[(at >> 2) % nx], y: down[Math.floor((at >> 2) / nx)] });
  return places.reverse();
}

/**
 * Points with those the wire does not turn at taken out: two in one place, or one on the line between
 * its neighbours, as a lane at the height of the way it goes into makes.
 */
function cornersOnly(all: readonly Point[]): Point[] {
  const points = all.filter((point, at) => at === 0 || point.x !== all[at - 1].x || point.y !== all[at - 1].y);
  return points.filter((point, at) => {
    if (at === 0 || at === points.length - 1) return true;
    const [before, after] = [points[at - 1], points[at + 1]];
    return !((before.x === point.x && point.x === after.x) || (before.y === point.y && point.y === after.y));
  });
}

/**
 * How near two lines a trace runs along may be before they are one: a step's middle and an If's are a
 * quarter of a pixel apart, and a trace stepped from the one to the other on its way.
 */
const APART = 1;

/**
 * The lines a trace runs along across one way, within low..high: each once, a line nearer than APART
 * to the last one kept left out — but the two ends' own, which are kept exactly, both of them however
 * near each other, and in place of a line near them.
 */
function lines(all: readonly number[], low: number, high: number, exact: readonly number[]): number[] {
  const marked = [...exact.map((at) => ({ at, exact: true })), ...all.map((at) => ({ at, exact: false }))]
    .filter(({ at }) => at >= low && at <= high)
    .sort((a, b) => a.at - b.at || Number(b.exact) - Number(a.exact));
  const kept: Array<{ at: number; exact: boolean }> = [];
  for (const one of marked) {
    const last = kept[kept.length - 1];
    if (last === undefined || one.at - last.at > APART) kept.push(one);
    else if (one.exact && !last.exact) kept[kept.length - 1] = one;
    else if (one.exact && one.at !== last.at) kept.push(one);
  }
  return kept.map(({ at }) => at);
}

/**
 * The cost of every step along the line at `at` — level, at that height, when `axis` is 'y' — from
 * each of `places` to the next: its length, more inside a node's margins or a port's mouth (`zones`)
 * and for each wire drawn round it crosses (`crossed`), and Infinity through a node or a name, or on
 * or beside another wire running the same way (`along`) but into the same port as it goes in.
 */
function costs(
  at: number,
  places: readonly number[],
  blocks: readonly Rect[],
  zones: ReadonlyArray<{ rect: Rect; weight: number }>,
  along: readonly Run[],
  crossed: readonly Run[],
  into: string | null,
  axis: 'x' | 'y',
): Float64Array {
  const count = Math.max(0, places.length - 1);
  const cost = new Float64Array(count);
  for (let step = 0; step < count; step++) cost[step] = places[step + 1] - places[step];

  // The steps lo..hi touches: from the first that ends past lo to the last that starts short of hi.
  const firstPast = (value: number) => {
    let [from, to] = [0, count];
    while (from < to) {
      const middle = (from + to) >> 1;
      if (places[middle + 1] > value) to = middle;
      else from = middle + 1;
    }
    return from;
  };
  const each = (lo: number, hi: number, visit: (step: number, shared: number) => void) => {
    for (let step = firstPast(lo); step < count && places[step] < hi; step++)
      visit(step, Math.min(hi, places[step + 1]) - Math.max(lo, places[step]));
  };
  const span = (rect: Rect) => (axis === 'y' ? [rect.y1, rect.y2, rect.x1, rect.x2] : [rect.x1, rect.x2, rect.y1, rect.y2]);

  for (const rect of blocks) {
    const [a, b, lo, hi] = span(rect);
    if (at > a && at < b) each(lo, hi, (step, shared) => shared > 0 && (cost[step] = Infinity));
  }
  for (const run of along)
    if (!(run.approach && run.into === into) && beside(at, run.at)) each(run.lo, run.hi, (step, shared) => shared > 0.5 && (cost[step] = Infinity));
  for (const { rect, weight } of zones) {
    const [a, b, lo, hi] = span(rect);
    if (at > a && at < b) each(lo, hi, (step, shared) => shared > 0 && (cost[step] += weight * shared));
  }
  for (const run of crossed)
    if (at > run.lo && at < run.hi) each(run.at, run.at, (step) => places[step] < run.at && run.at < places[step + 1] && (cost[step] += CROSSING));

  return cost;
}

/** The states a trace has yet to look past, the cheapest first: a binary heap. */
class Queue {
  private readonly keys: number[] = [];
  private readonly values: number[] = [];

  get size() {
    return this.keys.length;
  }

  push(key: number, value: number) {
    const { keys, values } = this;
    let at = keys.length;
    keys.push(key);
    values.push(value);
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (keys[parent] <= key) break;
      [keys[at], values[at]] = [keys[parent], values[parent]];
      at = parent;
    }
    [keys[at], values[at]] = [key, value];
  }

  pop(): number {
    const { keys, values } = this;
    const top = values[0];
    const [key, value] = [keys.pop()!, values.pop()!];
    if (keys.length > 0) {
      let at = 0;
      for (;;) {
        const left = 2 * at + 1;
        if (left >= keys.length) break;
        const child = left + 1 < keys.length && keys[left + 1] < keys[left] ? left + 1 : left;
        if (keys[child] >= key) break;
        [keys[at], values[at]] = [keys[child], values[child]];
        at = child;
      }
      [keys[at], values[at]] = [key, value];
    }
    return top;
  }
}

/**
 * The corners of a route as a reader draws it, from `source` to `target`, each run straight: out of a
 * way out on the right to `rise`, or down out of a foot — straight to the lane, or to `below` first
 * and across to `rise` — then up or down to `lane`, along it, and onto a next from straight above or
 * down beside a way in, at `drop`, and into it. Its two ends with them.
 */
function shaped(source: End, target: End, { rise, below, lane, drop }: Shape): Point[] {
  const down = below ?? source.y + MARGIN;
  const out: Point[] =
    source.side !== 'bottom'
      ? [{ x: rise ?? source.x, y: source.y }, { x: rise ?? source.x, y: lane }]
      : rise === null
        ? [{ x: source.x, y: lane }]
        : [{ x: source.x, y: down }, { x: rise, y: down }, { x: rise, y: lane }];
  const into: Point[] = target.side === 'top' ? [{ x: target.x, y: lane }] : [{ x: drop, y: lane }, { x: drop, y: target.y }];

  return cornersOnly([source, ...out, ...into, target]);
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

/** The path of a wire drawn round, from its way out to its way in, through the corners of its route. */
export function backPath({ source, target, corners }: { source: End; target: End; corners: Route }): string {
  return rounded([source, ...corners, target]);
}
