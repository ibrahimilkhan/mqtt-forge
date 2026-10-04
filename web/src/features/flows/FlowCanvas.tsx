import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  getBezierPath,
  Handle,
  Position,
  ReactFlow,
  useReactFlow,
  useStore,
  useStoreApi,
  useUpdateNodeInternals,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type InternalNode,
  type Node,
  type NodeChange,
  type NodeProps,
  type ReactFlowState,
} from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import { useShallow } from 'zustand/react/shallow';
import { own } from '../../lib/own';
import { isLive, nodeKey, shownRun, useFlowStatusStore, type FlowStatusState } from '../../stores/flowStatusStore';
import type { FlowDto, FlowNodeDto } from '../../types/api';
import { backPath, MARGIN, NAME_ROOM, namesOf, routes, Traces, type Box, type Drag, type End, type Leg, type Placed, type Route } from './backWires';
import {
  addNode,
  canConnect,
  connect,
  moveNodes,
  newId,
  noReturn,
  removeEdges,
  removeNodes,
  unreached,
  unwiredOuts,
  type Measure,
  type Problems,
  type Wire,
} from './flowDocument';
import { useFlowDraftStore } from './flowDraftStore';
import {
  isLoop,
  isNodeType,
  nameOf,
  NODE_SPECS,
  portsOf,
  sideOf,
  specOf,
  type NodeShape,
  type NodeSpec,
  type Ports,
  type Side,
} from './nodeTypes';
import styles from './FlowCanvas.module.css';

/** What a palette item carries when it is dragged onto the canvas. */
export const DRAG_TYPE = 'application/x-mqttforge-node';

/** The canvas's own id: the page finds it to put a new node in the middle of it. */
export const CANVAS = 'flow-canvas';

/** Puts the keyboard in the canvas, for a control that has just taken away the node it was about. */
export const focusCanvas = () => document.getElementById(CANVAS)?.focus();

/**
 * How wide a node is drawn. The stylesheet takes it from here, through --node-width on the canvas,
 * so the page's sums for where a new node goes and the node as drawn cannot come apart.
 */
export const NODE_WIDTH = 188;

/**
 * About how tall a node is drawn, with some to spare for a larger type size. A node's height is
 * its content's, so nothing is drawn at this: it is the room the page keeps for one when it puts a
 * new node down.
 */
export const NODE_HEIGHT = 80;

/**
 * How tall a step is drawn at the default type size, as Chrome lays it out: its three lines — the
 * name, what it is set to, what it has done — at the console's line height, with its padding and its
 * frame. A pill, the parallelogram and the hexagon are as tall. Nothing is drawn at this, since a node
 * is as tall as what is in it; it is what the examples are laid out by, so the wires along their rows
 * run level where the browser puts the ports, what a node put after a step is levelled by, and what
 * the renderer tells jsdom a node measures. Measured once and written once: a change to the type
 * scale moves it, and all of them with it.
 */
export const STEP_HEIGHT = 71.52;

/** The If's box: a diamond keeps its three lines in its middle, so it is drawn larger than the rest. */
export const DECISION_WIDTH = NODE_WIDTH + 64;
export const DECISION_HEIGHT = 128;

/** The room a node of each type takes as the palette reckons it: an If in its own box, every other node in a step's with some to spare under it. */
const boxOf = (type: string) =>
  specOf(type).shape === 'decision' ? { width: DECISION_WIDTH, height: DECISION_HEIGHT } : { width: NODE_WIDTH, height: NODE_HEIGHT };

/** How tall a node of each type is drawn. */
const heightOf = (type: string) => (specOf(type).shape === 'decision' ? DECISION_HEIGHT : STEP_HEIGHT);

/**
 * The room the palette keeps clear round a node it puts down free: a wire's way between it and the
 * next node, as the routes run one under a node and over another (backWires.ts), past the names of the
 * ports there. At 24, a node put free under another stood 32 under it, the name of its next a few
 * pixels under the name of the other's foot: a wire out of that foot had no way out of the gap, and
 * with a loop's return run along it, no way at all. A node put after another keeps a wire's margin
 * (MARGIN) instead, from what stands round the place it is put (see placeAfter), but for what one of
 * its ports faces, or what faces one of them, which keeps FACING (see crowds).
 */
const ROOM = 56;

/**
 * The room a port keeps in front of it, clear of the node it faces, when a node is put after another:
 * two margins, a stub out of the one port and a stub into the other, end to end. It is what the six
 * drawings that went wrong with a margin alone wanted (see paletteSessions.test.ts): in each, the two
 * ports stood 26 to 36 apart and the wire between them had no way to turn. At 36 two of them still go
 * wrong; from 37 on every one has its way, and 48 has some to spare. ROOM, wider, is more than any of
 * them needed, and brought the step down back: a row a reader laid 48.5 under a chain, with ports facing
 * up or down, was in the way of a For clicked into the chain, which went to a row of its own under the
 * row, and a Debug clicked after the Start pushed that row along with the chain.
 */
const FACING = 48;

/**
 * What a flow tells about each of its nodes' names: its ways out with no wire, its loops nothing comes
 * back to, and which nodes it has.
 */
type Wired = { open: ReadonlySet<string>; back: ReadonlySet<string>; has: ReadonlySet<string> };

/**
 * The names the canvas writes beside a node's ports, where the routes reckon them (namesOf), for the
 * flow it is in: its ways out with no wire say so, and a loop nothing comes back to says so at its
 * next. A node not in the flow yet is one being put down free: every way out it has wants a wire but
 * a loop's body, which comes back to the loop's own next (see addNode).
 */
function namesBeside(flow: FlowDto, node: FlowNodeDto, { open, back, has }: Wired = wiredIn(flow)): Box[] {
  const ports = portsOf(node, flow.edges);
  const unwired = has.has(node.id)
    ? [...ports.outs.filter((port) => open.has(`${node.id}:${port}`)), ...(back.has(node.id) ? ['next'] : [])]
    : ports.outs.filter((port) => !(isLoop(node.type) && port === 'body'));
  return namesOf(drawnAt(node), node.type, ports, unwired);
}

const wiredIn = (flow: FlowDto): Wired => ({ open: unwiredOuts(flow), back: noReturn(flow), has: new Set(flow.nodes.map((node) => node.id)) });

/** Where a node stands and how big it is drawn. */
const drawnAt = (node: FlowNodeDto): Box => ({ x: node.x, y: node.y, width: boxOf(node.type).width, height: heightOf(node.type) });

/** A port's mouth (see mouthsOf): where it stands, the side of its node the port is on, and the line its wire leaves or comes in along. */
type Mouth = { box: Box; side: Side; line: number };

/**
 * The mouths of a node's ports: the stretch in front of each, MARGIN long and NAME_ROOM either side of
 * the wire, that its wire runs through as it goes in or comes out, there as the stylesheet stands the
 * port — at the middle of its side, on the parallelogram's slanted sides 5% in. A node of a type this
 * build does not know spreads its ports along their sides, and has no palette to put it down: it has
 * none here.
 */
function mouthsOf(flow: FlowDto, node: FlowNodeDto): Mouth[] {
  if (!isNodeType(node.type)) return [];
  const { x, y, width, height } = drawnAt(node);
  const slant = specOf(node.type).shape === 'input' ? 0.05 * (width - 2) : 0;
  const ports = portsOf(node, flow.edges);
  const mouth = (side: Side): Mouth => {
    switch (side) {
      case 'left':
        return { box: { x: x + 1 + slant - 5 - MARGIN, y: y + height / 2 - NAME_ROOM, width: MARGIN, height: 2 * NAME_ROOM }, side, line: y + height / 2 };
      case 'right':
        return { box: { x: x + width - 1 - slant + 5, y: y + height / 2 - NAME_ROOM, width: MARGIN, height: 2 * NAME_ROOM }, side, line: y + height / 2 };
      case 'top':
        return { box: { x: x + width / 2 - NAME_ROOM, y: y + 1 - 5 - MARGIN, width: 2 * NAME_ROOM, height: MARGIN }, side, line: x + width / 2 };
      case 'bottom':
        return { box: { x: x + width / 2 - NAME_ROOM, y: y + height - 1 + 5, width: 2 * NAME_ROOM, height: MARGIN }, side, line: x + width / 2 };
    }
  };
  return [...ports.ins.map((port) => mouth(sideOf(port, false))), ...ports.outs.map((port) => mouth(sideOf(port, true)))];
}

/** Whether two boxes come within `room` of each other. */
const near = (a: Box, b: Box, room: number) =>
  a.x < b.x + b.width + room && b.x < a.x + a.width + room && a.y < b.y + b.height + room && b.y < a.y + a.height + room;

/** What stands of a node where the canvas draws it: its box, the names beside its ports, and their mouths. */
type Around = { box: Box; names: readonly Box[]; mouths: readonly Mouth[] };

/*
 * What stands round each node of a flow, worked out once for each flow and node, as flowDocument keeps
 * what it works out about a flow: no flow and no node is ever changed in place. The palette asks
 * whether a node crowds another of every two it weighs — every node of the flow against the place it
 * reckons, and every node it moves to make room against every node that stays — and worked out again
 * for each two, what stands round both, and the flow's wiring with it, made a click in a flow of two
 * hundred nodes tens of milliseconds long.
 */
const arounds = new WeakMap<FlowDto, { wired: Wired; nodes: WeakMap<FlowNodeDto, Around> }>();

function aroundOf(flow: FlowDto, node: FlowNodeDto): Around {
  let kept = arounds.get(flow);
  if (kept === undefined) {
    kept = { wired: wiredIn(flow), nodes: new WeakMap() };
    arounds.set(flow, kept);
  }
  let around = kept.nodes.get(node);
  if (around === undefined) {
    around = { box: drawnAt(node), names: namesBeside(flow, node, kept.wired), mouths: mouthsOf(flow, node) };
    kept.nodes.set(node, around);
  }
  return around;
}

/**
 * Whether two nodes crowd each other as the canvas draws them (see Crowds): their boxes within `room`;
 * a name of either over the other or in a mouth of its ports; or a port of either facing straight at
 * the other nearer than FACING.
 *
 * A wire out of a port, or into one, runs a margin straight out of it before it turns, and with another
 * node standing in front of the port it turns along that node, past which the routes run a lane only so
 * near — or comes in so, and the wires into the other node, and out of it, come through the same gap.
 * So a port wants room of its own in front of it, FACING, even where two nodes may otherwise stand a
 * wire's margin apart: put after a node within that, an If's no came down onto a For each 36 under it
 * where the loop's returns come down onto its next, a Clear alarm's foot stood 32 over a For each whose
 * next its returns came into along the gap from both sides, a Webhook's way out faced the End's way in
 * 30 off, and a Publish stood 26 in front of a way in two more wires came into. Rows a reader lays out
 * under a chain, of nodes with no port facing up or down, stand a margin apart as before.
 *
 * A name and a port stand within REACH of their node's box, so two nodes further apart than twice that
 * crowd each other by none of it, and what stands round them is not worked out at all: most of a flow,
 * for any one click.
 */
function crowds(flow: FlowDto, a: FlowNodeDto, b: FlowNodeDto, room: number): boolean {
  const [boxA, boxB] = [{ x: a.x, y: a.y, ...boxOf(a.type) }, { x: b.x, y: b.y, ...boxOf(b.type) }];
  if (near(boxA, boxB, room)) return true;
  if (!near(boxA, boxB, 2 * REACH)) return false;
  const [one, other] = [aroundOf(flow, a), aroundOf(flow, b)];
  const over = (names: readonly Box[], { box, mouths }: Around) =>
    names.some((name) => near(name, box, NAME_ROOM) || mouths.some((mouth) => near(name, mouth.box, 0)));
  return over(one.names, other) || over(other.names, one) || facing(one, other) || facing(other, one);
}

/** Whether a port of `one`'s faces straight at `other`'s box — its wire's line across it — nearer than FACING. */
function facing(one: Around, other: Around): boolean {
  const [mine, theirs] = [one.box, other.box];
  return one.mouths.some(({ side, line }) => {
    const across = side === 'left' || side === 'right' ? [theirs.y, theirs.y + theirs.height] : [theirs.x, theirs.x + theirs.width];
    if (line <= across[0] - NAME_ROOM || line >= across[1] + NAME_ROOM) return false;
    const gap = {
      right: theirs.x - (mine.x + mine.width),
      left: mine.x - (theirs.x + theirs.width),
      bottom: theirs.y - (mine.y + mine.height),
      top: mine.y - (theirs.y + theirs.height),
    }[side];
    return gap >= 0 && gap < FACING;
  });
}

/**
 * How far past its box a node's names and the mouths of its ports stand at the most, its ways out with
 * no wire, wire me and all; and half the room a port wants in front of it (see facing), at the least.
 */
const REACH = Math.max(
  FACING / 2,
  ...Object.values(NODE_SPECS).flatMap((spec) => {
    const node: FlowNodeDto = { id: '', type: spec.type as FlowNodeDto['type'], x: 0, y: 0, config: {} };
    const box = drawnAt(node);
    const alone: FlowDto = { id: '', name: '', enabled: false, variables: [], nodes: [], edges: [] };
    const past = (one: Box) => Math.max(-one.x, -one.y, one.x + one.width - box.width, one.y + one.height - box.height);
    return [...namesBeside(alone, node).map((name) => past(name) + NAME_ROOM), ...mouthsOf(alone, node).map((mouth) => past(mouth.box))];
  }),
);

/**
 * The nodes as the palette reckons them when it puts one down (see placeAfter and freeSpot): an If
 * in its own box, every other node in a step's with some to spare under it; each as tall as it is
 * drawn, to stand a node level with the one it follows; ROOM kept clear round a node put down free, a
 * wire's MARGIN round one put after another; and none of it crowding another node (crowds), as far as
 * REACH past its box.
 */
export const MEASURE: Measure = { boxOf, heightOf, room: ROOM, margin: MARGIN, crowds, reach: REACH };

/**
 * The sizes, where the stylesheet reads them: the If's as well, for the same reason as the width; and
 * how far past its node a wire going back turns up, which a port's name stands past.
 */
const NODE_SIZE = {
  '--node-width': `${NODE_WIDTH}px`,
  '--decision-width': `${DECISION_WIDTH}px`,
  '--decision-height': `${DECISION_HEIGHT}px`,
  '--wire-margin': `${MARGIN}px`,
} as CSSProperties;

/** Each outline drawn as a polygon, in a 100 by 100 box stretched over the node. */
const OUTLINES: Partial<Record<NodeShape, string>> = {
  input: '10,0 100,0 90,100 0,100',
  loop: '8,0 92,0 100,50 92,100 8,100 0,50',
  decision: '50,0 100,50 50,100 0,50',
};

const POSITIONS: Record<Side, Position> = {
  left: Position.Left,
  right: Position.Right,
  top: Position.Top,
  bottom: Position.Bottom,
};

/**
 * Where each port of a node of a type this build does not know stands along its side, by
 * `in:{port}` and `out:{port}`, as the stylesheet's --along reads it. Such a node takes its ports
 * from its wires (see portsOf), so any number of them can share a side — the old Alarm's raise and
 * clear both came in on the left — and in the middle of it, where a known type's one port to a side
 * stands, they were drawn as one. They are spread evenly along it instead, in the order its wires
 * name them, as every node's ports were before each known type was given its sides.
 */
function spread({ ins, outs }: Ports): ReadonlyMap<string, string> {
  const sides = new Map<Side, string[]>();
  const put = (key: string, side: Side) => sides.set(side, [...(sides.get(side) ?? []), key]);
  for (const port of ins) put(`in:${port}`, sideOf(port, false));
  for (const port of outs) put(`out:${port}`, sideOf(port, true));

  return new Map(
    [...sides.values()].flatMap((keys) => keys.map((key, at) => [key, `${((at + 1) * 100) / (keys.length + 1)}%`] as const)),
  );
}

/*
 * React Flow's options, made once. It copies each one it is handed into its own store when the
 * object it gets is a new one, and the canvas renders on every frame of a drag: an object written
 * out where it is passed would be a store update for nothing on each of those frames.
 */

/** A first view with room round the flow, and never closer than the size the nodes are drawn at. */
const FIT = { padding: 0.2, maxZoom: 1 };

/**
 * The least zoom a flow opens at: under it, a node's name and what it is set to are too small to
 * read. A flow that fits the canvas only further out opens at this instead (see FlowCanvas).
 */
const LEGIBLE = 0.6;

/** How far in from the canvas's left edge the Start stands when a flow opens at LEGIBLE. */
const START_INSET = 40;

/** Where the canvas looks, as React Flow keeps it: how far it is panned, and its zoom. */
type View = { x: number; y: number; zoom: number };

/**
 * Whether a box on the canvas — a node, in the canvas's own units — is wholly on screen in a canvas
 * `width` by `height` pixels looking at `view`.
 */
export const inView = (box: { x: number; y: number; width: number; height: number }, view: View, width: number, height: number) =>
  box.x * view.zoom + view.x >= 0 &&
  box.y * view.zoom + view.y >= 0 &&
  (box.x + box.width) * view.zoom + view.x <= width &&
  (box.y + box.height) * view.zoom + view.y <= height;

/** Where a dragged node comes to rest: every 8 pixels, on a dot of the background or halfway between two. */
const SNAP: [number, number] = [8, 8];

type NodeData = {
  flowId: string;
  /** The flow the node is in, for the line under its name: a Clear alarm's names the Raise alarm it closes. */
  flow: FlowDto;
  node: FlowNodeDto;
  ports: Ports;
  /**
   * The node's ports that want a wire, joined by a comma: its ways out with none, and a loop's next
   * when nothing comes back to it. Text and not a list, so canvasNode compares it by value.
   */
  unwired: string;
  /** No wire leads here from the Start, so no run would ever come to it. */
  unreached: boolean;
  problems?: readonly string[];
};
type CanvasNode = Node<NodeData, 'flow'>;
type CanvasEdge = Edge<{ flowId: string; problems?: readonly string[] }, 'wire'>;

type Size = { width: number; height: number };

/*
 * Each node as React Flow was last handed it, kept against the node it draws, as flowDocument keeps
 * what it works out about a flow: no node is ever changed in place, so an entry made for one never
 * goes stale. React Flow draws a node again only when it is handed a new object for it, and the
 * canvas works its nodes out again whenever the wires change — at two hundred nodes to a flow, one
 * wire drawn or taken away drew two hundred nodes again. So a node whose drawing has not changed is
 * handed over as the object it was. A wire changes the drawing of the nodes whose marks it changes —
 * a way out left with no wire, a node no longer reached — and of a node of a type this build does
 * not know, which takes its ports from its wires (see portsOf); every other node is left alone.
 */
const handed = new WeakMap<FlowNodeDto, CanvasNode>();

const sameNames = (a: readonly string[], b: readonly string[]) =>
  a === b || (a.length === b.length && a.every((name, at) => name === b[at]));

const samePorts = (a: Ports, b: Ports) => a === b || (sameNames(a.ins, b.ins) && sameNames(a.outs, b.outs));

/**
 * A node as React Flow is handed it: the object it had last time, when nothing it draws has changed.
 *
 * Only a Clear alarm's line reads the flow — the name of the Raise alarm it closes — so only a Clear
 * alarm is handed over again when the flow's nodes change. Every other node keeps the flow it was
 * made with, which it never reads, and is not drawn again for a change it does not show.
 */
function canvasNode(
  flow: FlowDto,
  node: FlowNodeDto,
  ports: Ports,
  unwired: string,
  cutOff: boolean,
  problems: readonly string[] | undefined,
  selected: boolean,
  measured: Size | undefined,
  dragging: boolean,
): CanvasNode {
  const last = handed.get(node);
  if (
    last !== undefined &&
    last.data.flowId === flow.id &&
    (node.type !== 'alarmClear' || last.data.flow.nodes === flow.nodes) &&
    last.data.unwired === unwired &&
    last.data.unreached === cutOff &&
    last.data.problems === problems &&
    last.selected === selected &&
    last.measured === measured &&
    last.dragging === dragging &&
    samePorts(last.data.ports, ports)
  )
    return last;

  const made: CanvasNode = {
    id: node.id,
    type: 'flow',
    position: { x: node.x, y: node.y },
    data: { flowId: flow.id, flow, node, ports, unwired, unreached: cutOff, problems },
    selected,
    measured,
    dragging,
    // Every run begins at the Start, so nothing takes it away: not the key here, and not React Flow.
    deletable: node.type !== 'start',
  };
  handed.set(node, made);
  return made;
}

const wireOf = (connection: Connection | CanvasEdge): Wire => ({
  from: connection.source,
  fromPort: connection.sourceHandle ?? '',
  to: connection.target,
  toPort: connection.targetHandle ?? '',
});

/*
 * A pick is kept under its kind as well as its id, `node:{id}` or `edge:{id}`, the way the
 * server's refusals are keyed. The server lets a node and a wire share an id, and picking one must
 * not frame the other; and letting go of "every node picked" needs to know which picks are nodes.
 */
const NODE = 'node:';
const EDGE = 'edge:';

/** The node a pick is of, or null when it is a wire. */
const nodeOf = (pick: string) => (pick.startsWith(NODE) ? pick.slice(NODE.length) : null);

/** The first node among some picks, for the inspector to show; null when there is none. */
function firstNode(picks: Iterable<string>): string | null {
  for (const pick of picks) {
    const node = nodeOf(pick);
    if (node !== null) return node;
  }
  return null;
}

/** The wire picked, when the picks are that one wire and nothing else: the store's `wire`. Null otherwise. */
function wireOnly(picks: Iterable<string>): string | null {
  const all = [...picks];
  return all.length === 1 && all[0].startsWith(EDGE) ? all[0].slice(EDGE.length) : null;
}

/** Whether a key went to a box being typed in, where Backspace takes away a letter and not a node. */
const typedInto = (target: EventTarget) =>
  target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName));

/** Whether a key went to a button or a link of its own, rather than to the canvas around it. */
const onAControl = (target: EventTarget) => target instanceof Element && target.closest('button, a') !== null;

/**
 * The canvas for one flow.
 *
 * Derived, not held. React Flow's nodes and edges are computed from `flow` on every render — the
 * draft if there is one, the deployed flow if not — and every change React Flow reports is turned
 * into a flowDocument function and written to the draft store. So there is one answer to "what is
 * this flow", it is the one Test runs and Activate saves, and a canvas can never drift from it.
 * What is kept here is only what React Flow measures (each node's size, which it needs handed back
 * or it hides the node) and what the reader has picked.
 *
 * What it marks as wrong is handed in, not looked up: the page decides what the server has said
 * about the flow — a refusal of this page's save or test, or a problem in the server's own file —
 * and the canvas, the tab and the inspector all mark that one answer. What the flow lacks to be a
 * whole program — a way out with no wire, a node nothing leads to, a loop nothing comes back to —
 * it works out for itself, from the flow, as the reader draws.
 */
export function FlowCanvas({ flow, problems }: { flow: FlowDto; problems: Problems }) {
  const edit = useFlowDraftStore((state) => state.edit);
  const select = useFlowDraftStore((state) => state.select);
  const pickWire = useFlowDraftStore((state) => state.pickWire);
  const selected = useFlowDraftStore((state) => state.selected);
  const wire = useFlowDraftStore((state) => state.wire);
  const [sizes, setSizes] = useState<Record<string, Size>>({});
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  // The nodes being dragged, as React Flow says with each move of one: the wires are worked out by it
  // (see routesIn), the dragged node's own on every frame and the rest when it is let go.
  const [dragged, setDragged] = useState<ReadonlySet<string>>(() => new Set());
  const { screenToFlowPosition, setViewport } = useReactFlow();
  const drawing = useStoreApi<CanvasNode, CanvasEdge>();

  // React Flow fits the flow to the canvas once it has measured the nodes: all of it on screen, never
  // larger than drawn. A long flow fitted so is a strip too small to read — the watch, nine steps
  // along its main line, came out at the least zoom the canvas allows, a node's name a few pixels
  // high. So a flow the fit puts under LEGIBLE opens at LEGIBLE instead, from where every run begins:
  // its Start START_INSET from the left edge, the middle of its rows halfway down. The reader pans
  // along it from there. The first view only: whoever zooms out later meant to.
  //
  // Unless a node is picked as the canvas opens and that view leaves it out: the alarm wall opens the
  // page on the Raise alarm an alarm came from, and a node picked before another panel took the canvas
  // away is picked still. Fitted, the whole flow was on screen, the node too; from the Start, the node
  // the reader came for could be out of sight. The view is on that node instead, at the same zoom.
  //
  // The fit is waited for when it is still to come. React Flow can have made it already, as the
  // canvas was drawn — a ResizeObserver that measures at once — and then it is taken as it is.
  useEffect(() => {
    const legible = () => {
      const { transform, nodeLookup, width, height } = drawing.getState();
      if (transform[2] >= LEGIBLE || nodeLookup.size === 0) return;

      let left = Infinity;
      let top = Infinity;
      let bottom = -Infinity;
      let start: { x: number; y: number; height: number } | undefined;
      for (const node of nodeLookup.values()) {
        const { x, y } = node.internals.positionAbsolute;
        left = Math.min(left, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y + (node.measured.height ?? 0));
        if (node.data.node.type === 'start') start = { x, y, height: node.measured.height ?? 0 };
      }
      // Too tall to show whole as well, the flow with the middle of its rows halfway down had its top
      // rows above the canvas, and its Start among them. It stands with its top START_INSET down
      // instead, as it stands with its Start START_INSET in; and when even that leaves the Start below
      // the canvas, with its Start there.
      const tall = (bottom - top) * LEGIBLE > height;
      let y = tall ? START_INSET - top * LEGIBLE : height / 2 - ((top + bottom) / 2) * LEGIBLE;
      if (start && (start.y + start.height) * LEGIBLE + y > height) y = START_INSET - start.y * LEGIBLE;
      const fromStart = { x: START_INSET - (start?.x ?? left) * LEGIBLE, y, zoom: LEGIBLE };

      const picked = nodeLookup.get(useFlowDraftStore.getState().selected ?? '');
      const box = picked && { ...picked.internals.positionAbsolute, width: picked.measured.width ?? 0, height: picked.measured.height ?? 0 };
      void setViewport(
        box && !inView(box, fromStart, width, height)
          ? { x: width / 2 - (box.x + box.width / 2) * LEGIBLE, y: height / 2 - (box.y + box.height / 2) * LEGIBLE, zoom: LEGIBLE }
          : fromStart,
      );
    };

    if (!drawing.getState().fitViewQueued) {
      legible();
      return;
    }

    const stop = drawing.subscribe((state) => {
      if (state.fitViewQueued) return;
      stop();
      legible();
    });
    return stop;
  }, [drawing, setViewport]);

  // React Flow reports one click as two batches of changes, the nodes' and then the wires' (or the
  // other way round), and both arrive before the canvas renders again. Each batch has to start from
  // the picks the one before it left, not from the last render's, or clicking a wire while a node
  // is picked would pick the wire and then drop it again. So the latest picks are kept here too.
  //
  // The store hears of every change to them as well, for the one wire picked: the palette puts what
  // it adds on that wire. Told of the changes a key or an edit makes as much as of a click's, it
  // never names a wire that has gone, or one the canvas has let go of. What changes the store's wire
  // from outside, the canvas follows (see below).
  const latest = useRef(picked);
  const choose = useCallback(
    (next: ReadonlySet<string>) => {
      latest.current = next;
      setPicked(next);
      pickWire(wireOnly(next));
    },
    [pickWire],
  );

  /** Lets go of some picks, and says what is left picked. */
  const drop = useCallback(
    (gone: readonly string[]) => {
      const left = new Set([...latest.current].filter((pick) => !gone.includes(pick)));
      if (left.size < latest.current.size) choose(left);
      return left;
    },
    [choose],
  );

  // What is picked follows the flow, and the store's choice of node and of wire.
  // - Something the flow no longer has is not picked, however it went: deleted here, its draft
  //   discarded, taken out from the inspector. Otherwise it would come back picked with the node
  //   or wire, and the next Backspace would take it away again without the reader choosing it.
  // - A node chosen somewhere else (the palette adds and picks one) is picked here instead.
  // - No node chosen means no node picked. The canvas only ever clears the choice when it has no
  //   node left picked, so a clear that finds one picked came from outside: a Discard, or the flow
  //   shown again from its tab. Wires picked with a node stay picked; picking only wires shows the
  //   flow's own settings anyway.
  // - The wire picked alone goes the same way. The canvas names it to the store whenever its picks
  //   change, so a store that names no wire while one is picked here alone was cleared from
  //   outside, by the same Discard or tab, and the wire is let go: left picked, it would be a wire
  //   drawn picked that the palette does not put its node on.
  // - A wire the store names while nothing is picked here is picked. The store outlives the canvas:
  //   another panel opened takes the canvas away, and it comes back with nothing picked while the
  //   store still names the wire, as it still names the node chosen, which the rule above picks
  //   again. The wire comes back picked the same way, so the wire the palette would use is the one
  //   on screen. The store could forget the wire when the canvas goes instead, but then a panel
  //   opened in between would lose a wire picked and keep a node.
  // - Whatever else happened, the store ends up naming the wire picked here alone, or none: not a
  //   wire the flow lost while the canvas was away.
  //
  // The store's wire is read as it is when this runs, not as the render before it had it, since the
  // store can change in between: the page, showing another flow in place of one that went, tells the
  // store so in a layout effect, after this canvas has drawn and before this runs. The wire that
  // render named was picked in the flow that went. Picked again here — flows share wire ids — it
  // would be a wire nobody picked in this one, and the one the palette puts its next node on. The
  // render's wire still says when to run. A node chosen needs no such care: this never tells the
  // store which node is chosen, so one read stale is let go again once the change comes through.
  useEffect(() => {
    const present = new Set([...flow.nodes.map((node) => NODE + node.id), ...flow.edges.map((edge) => EDGE + edge.id)]);
    const now = latest.current;
    const named = useFlowDraftStore.getState().wire;

    let next = [...now].filter((pick) => present.has(pick) && (selected !== null || nodeOf(pick) === null));
    if (selected !== null && present.has(NODE + selected) && !now.has(NODE + selected)) next = [NODE + selected];

    const alone = wireOnly(now);
    if (alone !== null && named === null) next = next.filter((pick) => pick !== EDGE + alone);
    else if (named !== null && next.length === 0 && present.has(EDGE + named)) next = [EDGE + named];

    if (next.length !== now.size || next.some((pick) => !now.has(pick))) choose(new Set(next));
    else if (wireOnly(next) !== named) pickWire(wireOnly(next));
  }, [choose, flow.edges, flow.nodes, pickWire, selected, wire]);

  // Worked out again whenever any of these changes, and each node handed over as the object it was
  // unless what it draws changed with it — see canvasNode. What the flow lacks is asked of the flow
  // object, which keeps the answer: a pick, a size measured or a refusal works the nodes out again
  // for the same flow, and reads it there. A drag gets nothing from it: each frame of one is a new
  // flow, from moveNodes, and is asked afresh.
  const nodes = useMemo<CanvasNode[]>(() => {
    const open = unwiredOuts(flow);
    const lost = unreached(flow);
    const back = noReturn(flow);

    return flow.nodes.map((node) => {
      const ports = portsOf(node, flow.edges);
      // A loop nothing comes back to wants a wire into its next as much as a way out wants one out.
      const unwired = [...ports.outs.filter((port) => open.has(`${node.id}:${port}`)), ...(back.has(node.id) ? ['next'] : [])];

      return canvasNode(
        flow,
        node,
        ports,
        unwired.join(','),
        lost.has(node.id),
        problems[NODE + node.id],
        picked.has(NODE + node.id),
        own(sizes, node.id),
        dragged.has(node.id),
      );
    });
  }, [dragged, flow, picked, problems, sizes]);

  const edges = useMemo<CanvasEdge[]>(
    () =>
      flow.edges.map((edge) => ({
        id: edge.id,
        type: 'wire',
        source: edge.from,
        sourceHandle: edge.fromPort,
        target: edge.to,
        targetHandle: edge.toPort,
        selected: picked.has(EDGE + edge.id),
        data: { flowId: flow.id, problems: problems[EDGE + edge.id] },
      })),
    [flow.id, flow.edges, picked, problems],
  );

  const pick = useCallback(
    (changes: ReadonlyArray<{ pick: string; selected: boolean }>) => {
      const next = new Set(latest.current);
      let last: string | null = null;

      for (const change of changes) {
        if (change.selected) {
          next.add(change.pick);
          last = nodeOf(change.pick) ?? last;
        } else next.delete(change.pick);
      }

      choose(next);

      // The inspector follows the node picked last. Picking only wires, or nothing, shows the
      // flow's own settings.
      select(last ?? firstNode(next));
    },
    [choose, select],
  );

  // React Flow reports moves, sizes and picks here. Never a node taken away: it has no key of its
  // own (see onKeyDown), and nothing else on the page asks it to take one.
  //
  // A move says whether it is a frame of a drag: every frame of one says so, and the drop says it no
  // longer is, from where the last frame left the node — as does a move by the arrow keys. A drag
  // broken off says so too, so no node is left marked as dragged.
  //
  // What moved and what was measured is gathered by node in a Map, and handed on as a record whose
  // every key is its own (see own): a node can be called __proto__, which assigned as a key changes
  // what the record inherits from, and its size went nowhere.
  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      const moved = new Map<string, { x: number; y: number }>();
      const measured = new Map<string, Size>();
      const picks: Array<{ pick: string; selected: boolean }> = [];
      const drags: Array<[string, boolean]> = [];

      for (const change of changes) {
        if (change.type === 'position') drags.push([change.id, change.dragging === true]);
        if (change.type === 'position' && change.position) moved.set(change.id, change.position);
        else if (change.type === 'dimensions' && change.dimensions) measured.set(change.id, change.dimensions);
        else if (change.type === 'select') picks.push({ pick: NODE + change.id, selected: change.selected });
      }

      if (drags.length > 0)
        setDragged((was) => {
          const now = new Set(was);
          for (const [id, on] of drags) {
            if (on) now.add(id);
            else now.delete(id);
          }
          return now.size === was.size && [...now].every((id) => was.has(id)) ? was : now;
        });
      if (moved.size > 0) edit(flow, (current) => moveNodes(current, Object.fromEntries(moved)));
      if (measured.size > 0) setSizes((known) => ({ ...known, ...Object.fromEntries(measured) }));
      if (picks.length > 0) pick(picks);
    },
    [edit, flow, pick],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<CanvasEdge>[]) => {
      const picks = changes.flatMap((change) =>
        change.type === 'select' ? [{ pick: EDGE + change.id, selected: change.selected }] : [],
      );

      if (picks.length > 0) pick(picks);
    },
    [pick],
  );

  // A way out has one wire, so a wire drawn from one that has a wire already takes its place.
  const onConnect = useCallback(
    (connection: Connection) => edit(flow, (current) => connect(current, wireOf(connection))),
    [edit, flow],
  );

  // Asked while a wire is being dragged, so a wire that would be refused never lands.
  const isValidConnection = useCallback(
    (connection: Connection | CanvasEdge) => canConnect(flow, wireOf(connection)),
    [flow],
  );

  const onDragOver = (event: DragEvent) => {
    if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };

  const onDrop = (event: DragEvent) => {
    const type = event.dataTransfer.getData(DRAG_TYPE);
    if (!isNodeType(type)) return;

    event.preventDefault();
    const id = newId('n');
    const at = screenToFlowPosition({ x: event.clientX, y: event.clientY });

    edit(flow, (current) => addNode(current, type, at, id));
    choose(new Set([NODE + id]));
    select(id);
  };

  // Backspace and Delete take away what is picked, and only while the keyboard is in the canvas.
  // React Flow listens for them on the whole document, where a node picked a while ago went when
  // the reader pressed Backspace on a tab, on a button beside the tabs or in the palette, out of
  // their sight. So it has no key of its own, and the canvas edits the draft itself — through
  // flowDocument, which keeps the program whole: a step taken out of a chain leaves the chain joined
  // over it, and the Start, where every run begins, is never taken out. A key held with another is
  // somebody's shortcut, and a key in a box takes away a letter. And a key on a button or a link is
  // that control's own — the zoom panel's, in the corner — and not about what is picked: a Backspace
  // there would take away whatever is, maybe a node panned out of sight a while ago.
  //
  // What goes may be what the keyboard is on: the node, a wire of it, the box round nodes picked
  // together. A browser hands the focus of an element taken out to the body, and the next key
  // would miss the canvas; so the keyboard is put in the canvas first. A node or a wire it was on
  // that stays keeps it.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Backspace' && event.key !== 'Delete') return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || typedInto(event.target) || onAControl(event.target)) return;

    event.preventDefault();
    const picks = [...latest.current];
    const wires = picks.flatMap((one) => (one.startsWith(EDGE) ? [one.slice(EDGE.length)] : []));
    const starts = new Set(flow.nodes.filter((node) => node.type === 'start').map((node) => node.id));
    const cut = picks.flatMap((one) => {
      const node = nodeOf(one);
      return node !== null && !starts.has(node) ? [node] : [];
    });
    if (cut.length === 0 && wires.length === 0) return;

    // Where the keyboard was, worked out as before — the node, a wire of it, or the box. A wire into
    // a node that goes may be joined over it and stay, but is counted as going: the canvas takes
    // the keyboard either way.
    const on = event.target instanceof Element ? event.target : null;
    const node = on?.closest('.react-flow__node')?.getAttribute('data-id');
    const wire = on?.closest('.react-flow__edge')?.getAttribute('data-id');
    const touching = new Set(flow.edges.filter((edge) => cut.includes(edge.from) || cut.includes(edge.to)).map((edge) => edge.id));
    const stays = node ? !cut.includes(node) : wire ? !(wires.includes(wire) || touching.has(wire)) : false;
    if (!stays) event.currentTarget.focus();

    // Wires first: a node's way on, picked with it, is meant gone, so what came into the node is not
    // joined over it to where that wire went.
    edit(flow, (current) => removeNodes(removeEdges(current, wires), cut));
    // What went is not picked any more. An inspector that was showing it shows another node still
    // picked, or the flow, and never a node that has gone.
    const left = drop([...cut.map((id) => NODE + id), ...wires.map((id) => EDGE + id)]);
    if (selected && cut.includes(selected)) select(firstNode(left));
    // As React Flow's own key does: the box drawn round nodes picked together goes with them.
    drawing.setState({ nodesSelectionActive: false });
  };

  return (
    <div
      className={styles.canvas}
      id={CANVAS}
      style={NODE_SIZE}
      // Clicked anywhere, the empty ground included, the canvas has the keyboard: a pan is a drag
      // on the ground, and a reader who picked a node and panned to see where it goes is still in
      // the canvas when they press Delete. Not a stop for the Tab key, which the nodes are.
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <ReactFlow<CanvasNode, CanvasEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        deleteKeyCode={null}
        fitView
        fitViewOptions={FIT}
        minZoom={0.25}
        maxZoom={2}
        snapToGrid
        snapGrid={SNAP}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>

      {/* A new flow is a Start wired straight to an End, never an empty canvas: what the reader
          needs to know is where its first step goes. */}
      {flow.nodes.length === 2 && flow.edges.length === 1 && (
        <p className={styles.hint}>Pick the wire, then click a node on the left to put it there.</p>
      )}
    </div>
  );
}

/**
 * What a node draws of its run, and nothing more: its line, whether the run is at it, and what the
 * run waits for there. Every push brings a new object for every node, so a node that took its whole
 * entry drew itself again four times a second whether anything on it had moved or not; this is
 * compared field by field, and a node whose line reads the same is left alone.
 *
 * The run on show reports every node of the flow it runs, so a node with no numbers is not in it:
 * no run is going, or the node is only in the draft. "0 in" or "waiting" under it would be a claim
 * about a run that is not there.
 *
 * `note` is the server's last word on the node: the value it last read or sent, or what last went
 * wrong — "The broker refused this filter.", "no such field". The line only counts errors, so it
 * is what the line says when a reader points at it.
 *
 * A node nothing leads to from the Start says `not reached`: a run of this drawing would never come
 * to it. That takes the place of `not running` and of nothing else. The canvas draws the draft, and
 * the run on show runs the copy the server has, which may still reach the node — may be at it,
 * waiting there — so what the run says of the node stays, after `not reached · ` (`cut`). The node
 * is faded and titled for it too, but neither reaches the keyboard or a screen reader; the line does.
 */
function drawnOf(spec: NodeSpec, flowId: string, nodeId: string, unreached: boolean, state: FlowStatusState) {
  const run = shownRun(own(state.runs, flowId));
  const status = state.nodes[nodeKey(flowId, nodeId)];
  const here = run !== undefined && isLive(run) && run.at === nodeId;
  const until = here ? (run.waiting?.until ?? null) : null;
  const message = here && run.waiting?.filter != null;

  return {
    line: status ? spec.status(status) : unreached ? 'not reached' : 'not running',
    cut: unreached && (status !== undefined || until !== null || message),
    failing: (status?.errors ?? 0) > 0,
    note: status?.note ?? null,
    here,
    until,
    message,
  };
}

function FlowNodeView({ id, data, selected }: NodeProps<CanvasNode>) {
  const spec = specOf(data.node.type);
  const { ins, outs } = data.ports;
  const Icon = spec.icon;
  const outline = OUTLINES[spec.shape];
  const unwired = data.unwired === '' ? [] : data.unwired.split(',');
  // A node with one way in and one way out has nothing to tell apart. One with more names its ways
  // out, and a loop its next, where the last wire of its body comes back; a way in called in never.
  const named = ins.length + outs.length > 2;
  const { line, cut, failing, note, here, until, message } = useFlowStatusStore(
    useShallow((state) => drawnOf(spec, data.flowId, id, data.unreached, state)),
  );

  // A known type's ports stand in the middle of their sides, where the stylesheet puts a port that
  // nothing places; an unknown type's are spread along theirs.
  const places = isNodeType(data.node.type) ? null : spread(data.ports);
  const along = (port: string, out: boolean) => {
    const at = places?.get(`${out ? 'out' : 'in'}:${port}`);
    return at === undefined ? undefined : ({ '--along': at } as CSSProperties);
  };

  // React Flow measures where a node's ports stand when it first draws the node, and draws its wires
  // to those places from then on. A known type's ports never move. Spread ones move when a wire of
  // their node goes or comes back, and are measured again, or the wires left would end where a port
  // used to be.
  const updateNodeInternals = useUpdateNodeInternals();
  const layout = places === null ? '' : [...places].join(' ');
  const measured = useRef(layout);
  useEffect(() => {
    if (measured.current === layout) return;
    measured.current = layout;
    updateNodeInternals(id);
  }, [id, layout, updateNodeInternals]);

  const portName = (port: string, out: boolean) => {
    const open = unwired.includes(port);
    const text = nameOf(port, named, open);
    return text ? (
      <span
        key={`name-${port}`}
        className={styles.port}
        style={along(port, out)}
        data-side={sideOf(port, out)}
        data-unwired={open ? '' : undefined}
      >
        {text}
      </span>
    ) : null;
  };

  const handle = (port: string, out: boolean) => (
    <Handle
      key={port}
      type={out ? 'source' : 'target'}
      position={POSITIONS[sideOf(port, out)]}
      id={port}
      className={styles.handle}
      style={along(port, out)}
      data-side={sideOf(port, out)}
      data-unwired={unwired.includes(port) ? '' : undefined}
    />
  );

  return (
    <div
      className={styles.node}
      data-shape={spec.shape}
      data-group={spec.group ?? undefined}
      data-selected={selected ? '' : undefined}
      data-problem={data.problems ? '' : undefined}
      data-unreached={data.unreached ? '' : undefined}
      data-here={here ? '' : undefined}
      title={data.problems?.join(' ') ?? (data.unreached ? 'Nothing leads here from Start.' : undefined)}
    >
      {outline && (
        <svg className={styles.outline} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <polygon points={outline} vectorEffect="non-scaling-stroke" />
        </svg>
      )}

      {ins.map((port) => handle(port, false))}
      {ins.map((port) => portName(port, false))}

      <div className={styles.head}>
        <span className={styles.icon}>
          <Icon />
        </span>
        <span className={styles.name}>{spec.label}</span>
      </div>
      {data.problems && <div className={styles.problem}>{data.problems[0]}</div>}
      <div className={styles.summary}>{spec.summary(data.node.config, data.flow)}</div>
      <div className={styles.status} data-errors={failing ? '' : undefined} title={note ?? undefined}>
        {cut && 'not reached · '}
        {until !== null ? <Countdown key={until} until={until} /> : message ? 'waiting for a message' : line}
      </div>

      {outs.map((port) => portName(port, true))}
      {outs.map((port) => handle(port, true))}
    </div>
  );
}

/**
 * The seconds left until `until`, to a tenth, counted down while it is on screen. Only the node a
 * run waits at draws one, so nothing else on the canvas ticks; and it stops at nothing left, which
 * it goes on saying until a push says where the run went — ticking on would only draw the same 0.0
 * ten times a second. Its clock is not read again once it has stopped, so a new wait is drawn by a
 * new countdown (the node keys it by its end), which starts from the time it is then.
 */
function Countdown({ until }: { until: string }) {
  const end = useMemo(() => Date.parse(until), [until]);
  const [now, setNow] = useState(() => Date.now());
  const over = now >= end;

  useEffect(() => {
    if (over) return;
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [over]);

  return <>{`${(Math.max(0, end - now) / 1000).toFixed(1)} s left`}</>;
}

/**
 * A wire that lights for a moment whenever the node it leaves sends something down it.
 *
 * The count it watches is the server's own, for that port, so the light means "a message went
 * this way" and not "something happened somewhere in the flow". Pushes come at most four times a
 * second, so a busy wire stays lit and a quiet one blinks — which is the difference a reader is
 * looking for.
 *
 * A wire going forward is React Flow's curve. One whose curve would run through what stands between
 * its ends goes round it instead, along the route worked out for it with every other such wire (see
 * backWires.ts and routesIn). Its marks are the same either way.
 */
function WireView({
  id,
  source,
  sourceHandleId,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
  data,
}: EdgeProps<CanvasEdge>) {
  const flowId = data?.flowId ?? '';
  const count = useFlowStatusStore((state) => state.nodes[nodeKey(flowId, source)]?.outs[sourceHandleId ?? 'out'] ?? 0);
  const [flash, setFlash] = useState(false);
  const seen = useRef(count);
  // Its route, as text, and none for the curve: compared by value, so the wire is drawn again when its
  // own route moves, and not for a node dragged a frame at a time out of its way, nor when another
  // wire's route moves.
  const route = useStore(useCallback((state: ReactFlowState) => routeKey(routesIn(state).get(id)), [id]));

  useEffect(() => {
    const before = seen.current;
    if (count === before) return;

    seen.current = count;

    // A count that went down is the flow starting again after an Update, or stopping: nothing went
    // down the wire, so nothing lights, and a light still on from before goes out with it.
    if (count < before) {
      setFlash(false);
      return;
    }

    setFlash(true);
    const timer = setTimeout(() => setFlash(false), 600);

    return () => clearTimeout(timer);
  }, [count]);

  const [path] =
    route === ''
      ? getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })
      : [
          backPath({
            source: { x: sourceX, y: sourceY, side: SIDES[sourcePosition] },
            target: { x: targetX, y: targetY, side: SIDES[targetPosition] },
            corners: routeFrom(route),
          }),
        ];

  return (
    <BaseEdge
      id={id}
      path={path}
      className={styles.wire}
      data-flash={flash ? '' : undefined}
      data-selected={selected ? '' : undefined}
      data-problem={data?.problems ? '' : undefined}
    />
  );
}

/** The side of its node a port stands on, by where React Flow says it is. */
const SIDES: Record<Position, Side> = {
  [Position.Left]: 'left',
  [Position.Right]: 'right',
  [Position.Top]: 'top',
  [Position.Bottom]: 'bottom',
};

/** A route as text, its corners one after another, for a wire to compare by value: empty for a wire drawn as the curve. */
const routeKey = (route: Route | undefined) => (route ? route.map(({ x, y }) => `${x},${y}`).join(' ') : '');

/** A route back from its text. */
const routeFrom = (key: string): Route =>
  key.split(' ').map((corner) => {
    const [x, y] = corner.split(',');
    return { x: Number(x), y: Number(y) };
  });

/*
 * Where every wire drawn round runs. Where one runs depends on where every node stands and on where
 * the others run — no two run on one line — so the routes are worked out for all of them at once
 * (routes, in backWires.ts), over the nodes and their ports as React Flow has measured them, and each
 * wire reads its own.
 *
 * Every wire asks whenever React Flow's store changes: a frame of a pan or of a drag, a node measured.
 * The routes are worked out once for each state of the store — the first wire to ask works them out,
 * the rest read what it found — and from scratch only when a node or a wire changed, which React Flow
 * tells by handing over a new object for it. A pan moves no node, and finds them all as they were.
 *
 * But not while a node is dragged (it is marked so, see onNodesChange): then only its own wires are
 * worked out on each frame, round the routes every other wire had when the drag began, which they keep
 * until the node is let go. Every wire worked out on every frame was a tenth of a second at a time in a
 * flow of a hundred nodes or more, and seconds once the node stood on another.
 */
type Plan = {
  nodes: readonly InternalNode[];
  edges: readonly Edge[];
  routes: ReadonlyMap<string, Route>;
  /** The routes of the last plan made with nothing dragged: the ones a drag holds the other wires to. */
  rest: ReadonlyMap<string, Route>;
  /** The drag going on, the same from one of its frames to the next (see Drag); none at rest. */
  drag?: Drag;
  /** The canvas's traces, which go when it goes. */
  traces: Traces;
};

/** The routes each canvas last worked out, and from what, by the map its store keeps its nodes in, which lives as long as the canvas does. */
const planned = new WeakMap<object, Plan>();

/** The routes for each state of a canvas's store. */
const asked = new WeakMap<object, ReadonlyMap<string, Route>>();

function routesIn(state: ReactFlowState): ReadonlyMap<string, Route> {
  const known = asked.get(state);
  if (known) return known;

  const nodes = [...state.nodeLookup.values()];
  const last = planned.get(state.nodeLookup);
  const same =
    last !== undefined &&
    last.edges === state.edges &&
    last.nodes.length === nodes.length &&
    last.nodes.every((node, at) => node === nodes[at]);

  if (same) {
    asked.set(state, last.routes);
    return last.routes;
  }

  const traces = last?.traces ?? new Traces();
  const moving = new Set(nodes.flatMap((node) => (node.dragging ? [node.id] : [])));
  // A frame of the drag the last plan was made for, when the same nodes are dragged; or the first of one.
  const was = last?.drag;
  const going = was !== undefined && was.moving.size === moving.size && [...moving].every((id) => was.moving.has(id));
  let drag: Drag | undefined;
  if (going) drag = was;
  else if (moving.size > 0 && last !== undefined) drag = { moving, held: last.rest, spent: new Set() };
  const found = routes(placedOf(nodes), legsOf(state), { traces, drag });
  planned.set(state.nodeLookup, { nodes, edges: state.edges, routes: found, rest: drag ? drag.held : found, drag, traces });

  asked.set(state, found);
  return found;
}

/** Each node React Flow has measured, where it stands, as big as it is drawn, and the names of its ports round it. */
function placedOf(nodes: readonly InternalNode[]): Placed[] {
  return nodes.flatMap((node) => {
    const { width, height } = node.measured;
    if (width === undefined || height === undefined) return [];

    const { node: drawn, ports, unwired } = node.data as NodeData;
    const box = { ...node.internals.positionAbsolute, width, height };
    return [{ id: node.id, box, names: namesOf(box, drawn.type, ports, unwired === '' ? [] : unwired.split(',')) }];
  });
}

/** Each wire with both its ends measured, its ends where React Flow ends it when it draws it (getHandlePosition). */
function legsOf({ edges, nodeLookup }: ReactFlowState): Leg[] {
  const endOf = (node: InternalNode | undefined, kind: 'source' | 'target', handle: string | null | undefined): End | null => {
    const bounds = node?.internals.handleBounds?.[kind]?.find((one) => one.id === handle);
    if (node === undefined || bounds === undefined) return null;

    const x = node.internals.positionAbsolute.x + bounds.x;
    const y = node.internals.positionAbsolute.y + bounds.y;
    switch (bounds.position) {
      case Position.Top:
        return { x: x + bounds.width / 2, y, side: 'top' };
      case Position.Right:
        return { x: x + bounds.width, y: y + bounds.height / 2, side: 'right' };
      case Position.Bottom:
        return { x: x + bounds.width / 2, y: y + bounds.height, side: 'bottom' };
      default:
        return { x, y: y + bounds.height / 2, side: 'left' };
    }
  };

  return edges.flatMap((edge) => {
    const source = endOf(nodeLookup.get(edge.source), 'source', edge.sourceHandle);
    const target = endOf(nodeLookup.get(edge.target), 'target', edge.targetHandle);
    return source && target ? [{ id: edge.id, from: edge.source, to: edge.target, toPort: edge.targetHandle ?? '', source, target }] : [];
  });
}

// Outside the component and never rebuilt: React Flow warns, and re-mounts every node, when these
// objects change identity between renders.
const nodeTypes = { flow: memo(FlowNodeView) };
const edgeTypes = { wire: memo(WireView) };
