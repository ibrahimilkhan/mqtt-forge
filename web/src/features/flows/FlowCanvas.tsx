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
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { injectNode } from '../../api/flows';
import { nodeKey, useFlowStatusStore } from '../../stores/flowStatusStore';
import { logFault } from '../../stores/logStore';
import type { FlowDto, FlowNodeDto } from '../../types/api';
import { addNode, canConnect, connect, moveNodes, newId, removeEdges, removeNodes, type Problems, type Wire } from './flowDocument';
import { useFlowDraftStore } from './flowDraftStore';
import { isNodeType, NODE_SPECS } from './nodeTypes';
import styles from './FlowCanvas.module.css';

/** What a palette item carries when it is dragged onto the canvas. */
export const DRAG_TYPE = 'application/x-mqttforge-node';

type NodeData = { flowId: string; node: FlowNodeDto; running: boolean; problems?: readonly string[] };
type CanvasNode = Node<NodeData, 'flow'>;
type CanvasEdge = Edge<{ flowId: string; problems?: readonly string[] }, 'wire'>;

type Size = { width: number; height: number };

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
 * canvas, the tab and the inspector all mark that one answer.
 */
export function FlowCanvas({ flow, running, problems }: { flow: FlowDto; running: boolean; problems: Problems }) {
  const edit = useFlowDraftStore((state) => state.edit);
  const select = useFlowDraftStore((state) => state.select);
  const selected = useFlowDraftStore((state) => state.selected);
  const [sizes, setSizes] = useState<Record<string, Size>>({});
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const { screenToFlowPosition } = useReactFlow();

  // React Flow reports one click as two batches of changes, the nodes' and then the wires' (or the
  // other way round), and both arrive before the canvas renders again. Each batch has to start from
  // the picks the one before it left, not from the last render's, or clicking a wire while a node
  // is picked would pick the wire and then drop it again. So the latest picks are kept here too.
  const latest = useRef(picked);
  const choose = useCallback((next: ReadonlySet<string>) => {
    latest.current = next;
    setPicked(next);
  }, []);

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

  const nodes = useMemo<CanvasNode[]>(
    () =>
      flow.nodes.map((node) => ({
        id: node.id,
        type: 'flow',
        position: { x: node.x, y: node.y },
        data: { flowId: flow.id, node, running, problems: problems[NODE + node.id] },
        selected: picked.has(NODE + node.id),
        measured: sizes[node.id],
      })),
    [flow.id, flow.nodes, picked, problems, running, sizes],
  );

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

  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      const moved: Record<string, { x: number; y: number }> = {};
      const measured: Record<string, Size> = {};
      const removed: string[] = [];
      const picks: Array<{ pick: string; selected: boolean }> = [];

      for (const change of changes) {
        if (change.type === 'position' && change.position) moved[change.id] = change.position;
        else if (change.type === 'dimensions' && change.dimensions) measured[change.id] = change.dimensions;
        else if (change.type === 'remove') removed.push(change.id);
        else if (change.type === 'select') picks.push({ pick: NODE + change.id, selected: change.selected });
      }

      if (Object.keys(moved).length > 0) edit(flow, (current) => moveNodes(current, moved));
      if (Object.keys(measured).length > 0) setSizes((known) => ({ ...known, ...measured }));
      if (removed.length > 0) {
        edit(flow, (current) => removeNodes(current, removed));
        // What was deleted is not picked any more. An inspector that was showing it shows another
        // node still picked, or the flow, and never a node that has gone.
        const left = drop(removed.map((id) => NODE + id));
        if (selected && removed.includes(selected)) select(firstNode(left));
      }
      if (picks.length > 0) pick(picks);
    },
    [drop, edit, flow, pick, select, selected],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<CanvasEdge>[]) => {
      const removed = changes.filter((change) => change.type === 'remove').map((change) => change.id);
      const picks = changes.flatMap((change) =>
        change.type === 'select' ? [{ pick: EDGE + change.id, selected: change.selected }] : [],
      );

      if (removed.length > 0) {
        edit(flow, (current) => removeEdges(current, removed));
        drop(removed.map((id) => EDGE + id));
      }
      if (picks.length > 0) pick(picks);
    },
    [drop, edit, flow, pick],
  );

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

  return (
    <div className={styles.canvas} id="flow-canvas" onDragOver={onDragOver} onDrop={onDrop}>
      <ReactFlow<CanvasNode, CanvasEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        deleteKeyCode={['Backspace', 'Delete']}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        minZoom={0.25}
        maxZoom={2}
        snapToGrid
        snapGrid={[8, 8]}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>

      {flow.nodes.length === 0 && (
        <p className={styles.hint}>Drag a trigger here from the left, or click one to add it.</p>
      )}
    </div>
  );
}

/** Where a port stands on its side of the node: spread evenly, top to bottom. */
const portTop = (index: number, count: number) => `${((index + 1) * 100) / (count + 1)}%`;

function FlowNodeView({ id, data, selected }: NodeProps<CanvasNode>) {
  const spec = NODE_SPECS[data.node.type];
  const Icon = spec.icon;
  const status = useFlowStatusStore((state) => state.nodes[nodeKey(data.flowId, id)]);

  // A running flow reports every node of the version it runs, so a node with no numbers is not
  // deployed: the flow is not running, or the node is only in the draft. "0 in" or "waiting" under
  // it would be a claim about something that is not running.
  const line = status ? spec.status(status) : 'not deployed';

  return (
    <div
      className={styles.node}
      data-group={spec.group}
      data-selected={selected ? '' : undefined}
      data-problem={data.problems ? '' : undefined}
      title={data.problems?.join(' ')}
    >
      {spec.ins.map((port, index) => (
        <Handle
          key={port}
          type="target"
          position={Position.Left}
          id={port}
          className={styles.handle}
          style={{ top: portTop(index, spec.ins.length) }}
        />
      ))}
      {spec.ins.length > 1 &&
        spec.ins.map((port, index) => (
          <span key={port} className={styles.portIn} style={{ top: portTop(index, spec.ins.length) }}>
            {port}
          </span>
        ))}

      <div className={styles.head}>
        <span className={styles.icon}>
          <Icon />
        </span>
        <span className={styles.name}>{spec.label}</span>
        {data.node.type === 'inject' && (
          <InjectButton flowId={data.flowId} nodeId={id} ready={data.running && status !== undefined} />
        )}
      </div>
      <div className={styles.summary}>{spec.summary(data.node.config)}</div>
      <div className={styles.status} data-errors={status && status.errors > 0 ? '' : undefined}>
        {line}
      </div>

      {spec.outs.length > 1 &&
        spec.outs.map((port, index) => (
          <span key={port} className={styles.portOut} style={{ top: portTop(index, spec.outs.length) }}>
            {port}
          </span>
        ))}
      {spec.outs.map((port, index) => (
        <Handle
          key={port}
          type="source"
          position={Position.Right}
          id={port}
          className={styles.handle}
          style={{ top: portTop(index, spec.outs.length) }}
        />
      ))}
    </div>
  );
}

function InjectButton({ flowId, nodeId, ready }: { flowId: string; nodeId: string; ready: boolean }) {
  return (
    <button
      type="button"
      className={`nodrag ${styles.inject}`}
      disabled={!ready}
      aria-label="Inject"
      title={ready ? 'Send its message now' : 'Deploy the flow first'}
      onClick={(event) => {
        event.stopPropagation();
        injectNode(flowId, nodeId).catch((error: unknown) => logFault('Inject failed', error));
      }}
    >
      ▶
    </button>
  );
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
