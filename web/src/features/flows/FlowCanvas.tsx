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
  useStoreApi,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
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
import { isLive, nodeKey, shownRun, useFlowStatusStore, type FlowStatusState } from '../../stores/flowStatusStore';
import type { FlowDto, FlowNodeDto } from '../../types/api';
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
  type Problems,
  type Wire,
} from './flowDocument';
import { useFlowDraftStore } from './flowDraftStore';
import {
  isNodeType,
  portLabel,
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

/** The If's box: a diamond keeps its three lines in its middle, so it is drawn larger than the rest. */
export const DECISION_WIDTH = NODE_WIDTH + 64;
export const DECISION_HEIGHT = 128;

/** The sizes, where the stylesheet reads them: the If's as well, for the same reason as the width. */
const NODE_SIZE = {
  '--node-width': `${NODE_WIDTH}px`,
  '--decision-width': `${DECISION_WIDTH}px`,
  '--decision-height': `${DECISION_HEIGHT}px`,
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

/*
 * React Flow's options, made once. It copies each one it is handed into its own store when the
 * object it gets is a new one, and the canvas renders on every frame of a drag: an object written
 * out where it is passed would be a store update for nothing on each of those frames.
 */

/** A first view with room round the flow, and never closer than the size the nodes are drawn at. */
const FIT = { padding: 0.2, maxZoom: 1 };

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
 * this flow", it is the one Deploy sends, and a canvas can never drift from it. What is kept here
 * is only what React Flow measures (each node's size, which it needs handed back or it hides the
 * node) and what the reader has picked.
 *
 * What it marks as wrong is handed in, not looked up: the page decides what the server has said
 * about the flow — a refusal of this page's deploy, or a problem in the server's own file — and the
 * canvas, the tab and the inspector all mark that one answer. What the flow lacks to be a whole
 * program — a way out with no wire, a node nothing leads to, a loop nothing comes back to — it works
 * out for itself, from the flow, as the reader draws.
 */
export function FlowCanvas({ flow, problems }: { flow: FlowDto; problems: Problems }) {
  const edit = useFlowDraftStore((state) => state.edit);
  const select = useFlowDraftStore((state) => state.select);
  const pickWire = useFlowDraftStore((state) => state.pickWire);
  const selected = useFlowDraftStore((state) => state.selected);
  const [sizes, setSizes] = useState<Record<string, Size>>({});
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const { screenToFlowPosition } = useReactFlow();
  const drawing = useStoreApi<CanvasNode, CanvasEdge>();

  // React Flow reports one click as two batches of changes, the nodes' and then the wires' (or the
  // other way round), and both arrive before the canvas renders again. Each batch has to start from
  // the picks the one before it left, not from the last render's, or clicking a wire while a node
  // is picked would pick the wire and then drop it again. So the latest picks are kept here too.
  //
  // The store hears of every change to them as well, for the one wire picked: the palette puts what
  // it adds on that wire. Told of the changes a key or an edit makes as much as of a click's, it
  // never names a wire that has gone, or one the canvas has let go of.
  const latest = useRef(picked);
  const choose = useCallback(
    (next: ReadonlySet<string>) => {
      latest.current = next;
      setPicked(next);

      const only = next.size === 1 ? [...next][0] : null;
      pickWire(only?.startsWith(EDGE) ? only.slice(EDGE.length) : null);
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

  // What is picked follows the flow and the store's choice of node.
  // - Something the flow no longer has is not picked, however it went: deleted here, its draft
  //   discarded, taken out from the inspector. Otherwise it would come back picked with the node
  //   or wire, and the next Backspace would take it away again without the reader choosing it.
  // - A node chosen somewhere else (the palette adds and picks one) is picked here instead.
  // - No node chosen means no node picked. The canvas only ever clears the choice when it has no
  //   node left picked, so a clear that finds one picked came from outside: a Discard, or another
  //   flow shown. The wires stay picked; picking only wires shows the flow's own settings anyway.
  useEffect(() => {
    const present = new Set([...flow.nodes.map((node) => NODE + node.id), ...flow.edges.map((edge) => EDGE + edge.id)]);
    const now = latest.current;

    let next = [...now].filter((pick) => present.has(pick) && (selected !== null || nodeOf(pick) === null));
    if (selected !== null && present.has(NODE + selected) && !now.has(NODE + selected)) next = [NODE + selected];

    if (next.length !== now.size || next.some((pick) => !now.has(pick))) choose(new Set(next));
  }, [choose, flow.edges, flow.nodes, selected]);

  // Worked out again whenever any of these changes, and each node handed over as the object it was
  // unless what it draws changed with it — see canvasNode. What the flow lacks is asked of the flow
  // object, which keeps the answer: a drag asks on every frame.
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
        sizes[node.id],
      );
    });
  }, [flow, picked, problems, sizes]);

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
  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      const moved: Record<string, { x: number; y: number }> = {};
      const measured: Record<string, Size> = {};
      const picks: Array<{ pick: string; selected: boolean }> = [];

      for (const change of changes) {
        if (change.type === 'position' && change.position) moved[change.id] = change.position;
        else if (change.type === 'dimensions' && change.dimensions) measured[change.id] = change.dimensions;
        else if (change.type === 'select') picks.push({ pick: NODE + change.id, selected: change.selected });
      }

      if (Object.keys(moved).length > 0) edit(flow, (current) => moveNodes(current, moved));
      if (Object.keys(measured).length > 0) setSizes((known) => ({ ...known, ...measured }));
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
  // the reader pressed Backspace on a tab, on Deploy or in the palette, out of their sight. So it
  // has no key of its own, and the canvas edits the draft itself — through flowDocument, which
  // keeps the program whole: a step taken out of a chain leaves the chain joined over it, and the
  // Start, where every run begins, is never taken out. A key held with another is somebody's
  // shortcut, and a key in a box takes away a letter. And a key on a button or a link is that
  // control's own — the zoom panel's, in the corner — and not about what is picked: a Backspace
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
 */
function drawnOf(spec: NodeSpec, flowId: string, nodeId: string, state: FlowStatusState) {
  const run = shownRun(state.runs[flowId]);
  const status = state.nodes[nodeKey(flowId, nodeId)];
  const here = run !== undefined && isLive(run) && run.at === nodeId;

  return {
    line: status ? spec.status(status) : 'not running',
    failing: (status?.errors ?? 0) > 0,
    note: status?.note ?? null,
    here,
    until: here ? (run.waiting?.until ?? null) : null,
    message: here && run.waiting?.filter != null,
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
  const { line, failing, note, here, until, message } = useFlowStatusStore(
    useShallow((state) => drawnOf(spec, data.flowId, id, state)),
  );

  const portName = (port: string, out: boolean) => {
    const open = unwired.includes(port);
    const name = named && port !== 'in' ? portLabel(port) : '';
    const text = open ? (name ? `${name} · wire me` : 'wire me') : name;
    return text ? (
      <span key={`name-${port}`} className={styles.port} data-side={sideOf(port, out)} data-unwired={open ? '' : undefined}>
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
        {until !== null ? <Countdown until={until} /> : message ? 'waiting for a message' : line}
      </div>

      {outs.map((port) => portName(port, true))}
      {outs.map((port) => handle(port, true))}
    </div>
  );
}

/**
 * The seconds left until `until`, to a tenth, counted down while it is on screen. Only the node a
 * run waits at draws one, so nothing else on the canvas ticks.
 */
function Countdown({ until }: { until: string }) {
  const end = useMemo(() => Date.parse(until), [until]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, []);

  return <>{`${(Math.max(0, end - now) / 1000).toFixed(1)} s left`}</>;
}

/**
 * A wire that lights for a moment whenever the node it leaves sends something down it.
 *
 * The count it watches is the server's own, for that port, so the light means "a message went
 * this way" and not "something happened somewhere in the flow". Pushes come at most four times a
 * second, so a busy wire stays lit and a quiet one blinks — which is the difference a reader is
 * looking for.
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

  useEffect(() => {
    const before = seen.current;
    if (count === before) return;

    seen.current = count;

    // A count that went down is the flow starting again after a deploy, or stopping: nothing went
    // down the wire, so nothing lights, and a light still on from before goes out with it.
    if (count < before) {
      setFlash(false);
      return;
    }

    setFlash(true);
    const timer = setTimeout(() => setFlash(false), 600);

    return () => clearTimeout(timer);
  }, [count]);

  const [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });

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

// Outside the component and never rebuilt: React Flow warns, and re-mounts every node, when these
// objects change identity between renders.
const nodeTypes = { flow: memo(FlowNodeView) };
const edgeTypes = { wire: memo(WireView) };
