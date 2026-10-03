import { Position } from '@xyflow/react';

/*
 * How a wire that goes back is drawn: the last wire of a loop's body, coming back to the loop's next,
 * and any wire that comes into a way in standing left of the way out it leaves.
 *
 * Every wire was React Flow's curve, which leaves a port and arrives at one along the sides they
 * stand on. Going forward, from a way out on the right to a way in further right, that is the line
 * a reader draws by hand. Going back it is not: a curve from a way out on the right into a next on
 * top, further left, stayed at about the height of the row it left and came back through the very
 * nodes it ran past — through the body of its own loop — and one from a way out at the foot of a
 * node, going back up to its loop, crossed whatever row stood between. In the examples, five of
 * their six returns ran behind nodes, and a chain clicked together ran its last wire back to the End
 * behind the chain.
 *
 * So a wire that goes back goes round instead, the way a flowchart drawn by hand does: out of its
 * port sideways, up to a lane above every node standing between its two ends, back along the lane,
 * and down onto the next from straight above — or, to a way in, down beside it and into it from its
 * left. Square, with its corners rounded, so it reads as a route and not as one more curve among
 * the wires going forward.
 */

/** How far a wire going back runs out of its port, and stands off the way in it comes into, before it turns. */
export const MARGIN = 24;

/** How far above the highest node between its ends a wire going back runs. */
const OVER = 32;

/**
 * How far above the top of the node it comes back to it runs at the least: a node not yet measured
 * stands nowhere in the reckoning of what is between, and the wire still comes down onto it.
 */
const ONTO = 24;

/** The corners' radius. */
const CORNER = 8;

type Point = { x: number; y: number };

/**
 * Whether a wire goes back: into a port on top — a loop's next, where its body comes back to it — or
 * into a way in standing left of the way out it leaves.
 */
export const goesBack = (sourceX: number, targetX: number, targetPosition: Position) =>
  targetPosition === Position.Top || targetX < sourceX;

/**
 * Where a wire going back rises to its lane. Out of a way out on the right, the margin past the port;
 * out of one at the foot of its node, the margin past the node's right edge, after going down the
 * margin first — rising straight from the port, it would go up through its own node.
 */
export const riseOf = (sourceX: number, sourcePosition: Position, sourceRight: number) =>
  (sourcePosition === Position.Bottom ? sourceRight : sourceX) + MARGIN;

/** Where it comes down from its lane: straight above a next, or the margin left of a way in. */
export const dropOf = (targetX: number, targetPosition: Position) =>
  targetPosition === Position.Top ? targetX : targetX - MARGIN;

/** The lane, from the top of the highest node between the wire's ends and the top of the node it comes back to. */
export const laneOver = (highest: number, targetTop: number) => Math.min(highest - OVER, targetTop - ONTO);

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

/** The path of a wire going back, from its port to the one it comes back to, along `lane`, rising at `rise`. */
export function backPath(route: {
  sourceX: number;
  sourceY: number;
  sourcePosition: Position;
  rise: number;
  lane: number;
  targetX: number;
  targetY: number;
  targetPosition: Position;
}): string {
  const { sourceX, sourceY, sourcePosition, rise, lane, targetX, targetY, targetPosition } = route;
  const drop = dropOf(targetX, targetPosition);

  const out: Point[] =
    sourcePosition === Position.Bottom
      ? [{ x: sourceX, y: sourceY + MARGIN }, { x: rise, y: sourceY + MARGIN }]
      : [{ x: rise, y: sourceY }];
  const into: Point[] = targetPosition === Position.Top ? [{ x: drop, y: lane }] : [{ x: drop, y: lane }, { x: drop, y: targetY }];

  return rounded([{ x: sourceX, y: sourceY }, ...out, { x: rise, y: lane }, ...into, { x: targetX, y: targetY }]);
}
