import { ReactFlowProvider, useStoreApi } from '@xyflow/react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Profiler, useLayoutEffect } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { nodeKey, useFlowStatusStore } from '../../stores/flowStatusStore';
import { renderWithClient as render } from '../../test/renderWithClient';
import type { FlowDto, FlowNodeStatusDto, FlowStatusDto, FlowWaitingDto } from '../../types/api';
import {
  forgetDrafts,
  MeasuredTogether,
  paneSized,
  runOf,
  standInForTheBrowser,
  viewport,
  withoutComments,
} from './canvasTestbed';
import * as backWires from './backWires';
import { DRAG_TYPE, FlowCanvas } from './FlowCanvas';
import sheet from './FlowCanvas.module.css?raw';
import { connect, moveNodes, removeEdges, setConfig, type Problems } from './flowDocument';
import { useFlowDraftStore } from './flowDraftStore';
import { NODE_SPECS } from './nodeTypes';

beforeAll(() => standInForTheBrowser());
afterAll(() => vi.unstubAllGlobals());

beforeEach(() => {
  localStorage.clear();
  forgetDrafts();
  useFlowStatusStore.setState(useFlowStatusStore.getInitialState());
});

// The countdown's case runs on a fake clock. Should it fail before it puts the real one back, the
// cases after it must not inherit the fake.
afterEach(() => vi.useRealTimers());

const button: FlowDto = {
  id: 'button',
  name: 'Button',
  enabled: true,
  variables: [],
  nodes: [
    { id: 'start', type: 'start', x: 0, y: 80, config: {} },
    { id: 'test', type: 'if', x: 300, y: 80, config: { field: '$.temp', test: 'gt', value: '90', value2: '' } },
    { id: 'end', type: 'end', x: 600, y: 80, config: {} },
  ],
  edges: [
    { id: 'e1', from: 'start', fromPort: 'out', to: 'test', toPort: 'in' },
    { id: 'e2', from: 'test', fromPort: 'yes', to: 'end', toPort: 'in' },
    { id: 'e3', from: 'test', fromPort: 'no', to: 'end', toPort: 'in' },
  ],
};

/** A status push with one active run of the button flow, at `at`, waiting as `waiting` says. */
const active = (nodes: FlowNodeStatusDto[], at: string | null = null, waiting: FlowWaitingDto | null = null): FlowStatusDto => ({
  runs: [runOf('button', { state: waiting ? 'waiting' : 'running', at, waiting, nodes })],
});

const draw = (flow: FlowDto = button, problems: Problems = {}) =>
  render(
    <ReactFlowProvider>
      <div style={{ width: 800, height: 600 }}>
        <FlowCanvas flow={flow} problems={problems} />
      </div>
    </ReactFlowProvider>,
  );

/**
 * Nothing wrong, as one object, which the page hands over for a flow with no problems: a new one on
 * each render would draw every wire again on every edit, which the page never does.
 */
const NOTHING_WRONG: Problems = {};

/** The canvas as the page draws it: the flow's draft once it has one, the deployed flow until then. */
function Page({ flow }: { flow: FlowDto }) {
  const draft = useFlowDraftStore((state) => state.drafts[flow.id]);
  return <FlowCanvas flow={draft ?? flow} problems={NOTHING_WRONG} />;
}

/**
 * The canvas for a flow the page shows in place of the one on screen, which went: the page tells the
 * store in a layout effect, once the canvas for the flow it falls back to has been drawn.
 */
function ShownInPlace({ flow }: { flow: FlowDto }) {
  useLayoutEffect(() => {
    useFlowDraftStore.getState().show(flow.id);
  }, [flow.id]);
  return <FlowCanvas flow={flow} problems={{}} />;
}

/** A flow on screen the way the page puts it there, so a Discard redraws the canvas. */
const drawPage = (flow: FlowDto = button) => {
  useFlowDraftStore.getState().show(flow.id);
  return render(
    <ReactFlowProvider>
      <div style={{ width: 800, height: 600 }}>
        <Page flow={flow} />
      </div>
    </ReactFlowProvider>,
  );
};

/** A port on the canvas, by its node and its name. */
const port = (nodeId: string, name: string) =>
  document.querySelector<HTMLElement>(`.react-flow__handle[data-nodeid="${nodeId}"][data-handleid="${name}"]`)!;

/** The ids of the draft's wires, in the order it has them. */
const wireIds = () => useFlowDraftStore.getState().drafts.button?.edges.map((edge) => edge.id);

describe('flow canvas', () => {
  it('draws each node with its name, its settings and what it has done', async () => {
    useFlowStatusStore.getState().setStatus(active([{ id: 'test', count: 5, outs: { yes: 2, no: 3 }, errors: 0, note: null, standing: [] }]));

    draw();

    expect(await screen.findByText('If')).toBeInTheDocument();
    expect(screen.getByText('$.temp > 90')).toBeInTheDocument();
    expect(screen.getByText('yes 2 · no 3')).toBeInTheDocument();
    // The If's two ways out are named where they leave it.
    expect(screen.getByText('yes')).toBeInTheDocument();
    expect(screen.getByText('no')).toBeInTheDocument();
  });

  // A Clear alarm's line names the Raise alarm it closes: a setting of another node. Renamed, the
  // line follows, though nothing of the Clear alarm's own has changed.
  it('names the Raise alarm a Clear alarm closes, and follows it when it is renamed', async () => {
    const raise = { id: 'hot', type: 'alarmRaise', x: 600, y: -80, config: { name: 'Boiler too hot', level: 'warn', reason: '{{topic}}', value: '' } };
    const alarmed: FlowDto = {
      ...button,
      nodes: [...button.nodes, raise, { id: 'cool', type: 'alarmClear', x: 600, y: 240, config: { alarm: 'hot' } }],
      edges: [
        button.edges[0],
        { id: 'e2', from: 'test', fromPort: 'yes', to: 'hot', toPort: 'in' },
        { id: 'e3', from: 'test', fromPort: 'no', to: 'cool', toPort: 'in' },
        { id: 'e4', from: 'hot', fromPort: 'raised', to: 'end', toPort: 'in' },
        { id: 'e5', from: 'hot', fromPort: 'up', to: 'end', toPort: 'in' },
        { id: 'e6', from: 'cool', fromPort: 'cleared', to: 'end', toPort: 'in' },
        { id: 'e7', from: 'cool', fromPort: 'none', to: 'end', toPort: 'in' },
      ],
    };
    drawPage(alarmed);
    expect(await screen.findByText('closes Boiler too hot')).toBeInTheDocument();

    act(() => useFlowDraftStore.getState().edit(alarmed, (flow) => setConfig(flow, 'hot', { ...raise.config, name: 'Kiln too hot' })));

    expect(await screen.findByText('closes Kiln too hot')).toBeInTheDocument();
  });

  // A newer build's node, in a flow the server kept. It is drawn by its type, and its wires still
  // have ports to meet: the ones they name, since this build knows no others for it.
  it('draws a node of a type it does not know by that type, meeting the wires it has', async () => {
    draw({
      ...button,
      nodes: [...button.nodes, { id: 'fn', type: 'function', x: 600, y: -80, config: { code: 'return msg;' } }],
      edges: button.edges.map((edge) => (edge.id === 'e2' ? { ...edge, to: 'fn' } : edge)),
    });

    expect(await screen.findByText('function')).toBeInTheDocument();
    expect(screen.getByText('not known to this build')).toBeInTheDocument();
    expect(port('fn', 'in')).not.toBeNull();
    expect(document.querySelectorAll('.react-flow__handle[data-nodeid="fn"]')).toHaveLength(1);
    expect(screen.getByLabelText('Edge from test to fn')).toBeInTheDocument();
  });

  // A node of a type this build does not know takes its ports from its wires, so it can have any
  // number on one side — here two ways in on the left and two ways out on the right. Each stands at
  // a place of its own along its side, its name beside it, so no two are drawn as one; a type this
  // build knows has one port to a side, in the middle of it.
  it('spreads along their side the ports of a node of a type it does not know', async () => {
    draw({
      ...button,
      nodes: [...button.nodes, { id: 'fn', type: 'switch', x: 450, y: -80, config: {} }],
      edges: [
        button.edges[0],
        { id: 'e2', from: 'test', fromPort: 'yes', to: 'fn', toPort: 'in' },
        { id: 'e3', from: 'test', fromPort: 'no', to: 'fn', toPort: 'reset' },
        { id: 'e4', from: 'fn', fromPort: 'hot', to: 'end', toPort: 'in' },
        { id: 'e5', from: 'fn', fromPort: 'cold', to: 'end', toPort: 'in' },
      ],
    });
    await screen.findByText('switch');
    const along = (element: HTMLElement) => element.style.getPropertyValue('--along');

    expect(along(port('fn', 'in'))).not.toBe(along(port('fn', 'reset')));
    expect(along(port('fn', 'hot'))).not.toBe(along(port('fn', 'cold')));
    expect(along(screen.getByText('hot'))).toBe(along(port('fn', 'hot')));
    expect(along(screen.getByText('cold'))).toBe(along(port('fn', 'cold')));
    expect(along(port('test', 'yes'))).toBe('');

    // What the stylesheet reads it by: every port, and every port's name, stands there along its
    // side, and in the middle when nothing says.
    const rules = withoutComments(sheet);
    for (const side of ['left', 'right', 'top', 'bottom'])
      for (const part of ['handle', 'port'])
        expect(rules).toMatch(new RegExp(String.raw`\.${part}\[data-side='${side}'\][^{]*\{[^}]*var\(--along, 50%\)`));
  });

  // React Flow measures where a node's ports stand when it first draws the node, and draws its wires
  // to those places after. A spread port moves when a wire of its node goes, and the wire it still
  // has must meet it where it now stands.
  it('measures again where the spread ports stand when a wire of their node goes', async () => {
    // jsdom lays nothing out: a port is put as far down as its place along the side says.
    const box = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const top = this.classList.contains('react-flow__handle')
        ? Number.parseFloat((this as HTMLElement).style.getPropertyValue('--along')) || 50
        : 0;
      return { x: 0, y: top, top, left: 0, right: 0, bottom: top, width: 0, height: 0, toJSON: () => ({}) };
    });
    let drawing: ReturnType<typeof useStoreApi> | undefined;
    function Peek() {
      drawing = useStoreApi();
      return null;
    }
    // Where React Flow has the switch's ways out, as a share of its side.
    const measured = () => {
      const zoom = drawing!.getState().transform[2];
      return drawing!.getState().nodeLookup.get('fn')?.internals.handleBounds?.source?.map((one) => `${one.id} ${Math.round(one.y * zoom)}%`);
    };
    const odd: FlowDto = {
      ...button,
      nodes: [...button.nodes, { id: 'fn', type: 'switch', x: 450, y: -80, config: {} }],
      edges: [
        ...button.edges.map((edge) => (edge.id === 'e2' ? { ...edge, to: 'fn' } : edge)),
        { id: 'e4', from: 'fn', fromPort: 'hot', to: 'end', toPort: 'in' },
        { id: 'e5', from: 'fn', fromPort: 'cold', to: 'end', toPort: 'in' },
      ],
    };

    try {
      useFlowDraftStore.getState().show('button');
      render(
        <ReactFlowProvider>
          <div style={{ width: 800, height: 600 }}>
            <Page flow={odd} />
          </div>
          <Peek />
        </ReactFlowProvider>,
      );
      await waitFor(() => expect(measured()).toEqual(['hot 33%', 'cold 67%']));

      act(() => useFlowDraftStore.getState().edit(odd, (flow) => removeEdges(flow, ['e5'])));

      await waitFor(() => expect(measured()).toEqual(['hot 50%']));
    } finally {
      box.mockRestore();
    }
  });

  // The server's last word on a node — the value it read, or what went wrong — is the only place it
  // says why a count of errors went up.
  it('gives each node\'s status line the server\'s last word on it', async () => {
    useFlowStatusStore.getState().setStatus(
      active([
        { id: 'test', count: 5, outs: { yes: 2, no: 3 }, errors: 0, note: 'no such field', standing: [] },
        { id: 'fan', count: 1, outs: {}, errors: 1, note: 'More than 50 publishes a second; this one was dropped.', standing: [] },
      ]),
    );

    draw({
      ...button,
      nodes: [...button.nodes, { id: 'fan', type: 'publish', x: 450, y: -80, config: { topic: 'plant/k1/cmd', payload: '{"fan":"on"}', qos: 1, retain: false } }],
      edges: [
        ...button.edges.map((edge) => (edge.id === 'e2' ? { ...edge, to: 'fan' } : edge)),
        { id: 'e4', from: 'fan', fromPort: 'out', to: 'end', toPort: 'in' },
      ],
    });

    expect(await screen.findByText('0 sent · 1 error')).toHaveAttribute('title', 'More than 50 publishes a second; this one was dropped.');
    expect(screen.getByText('yes 2 · no 3')).toHaveAttribute('title', 'no such field');
  });

  // The run on show reports every node of the flow it runs, so a node it does not report is one
  // that is only in the draft. "Waiting" would say it is running and has had nothing yet.
  it('says not running under a node the run on show does not report', async () => {
    useFlowStatusStore.getState().setStatus(active([{ id: 'start', count: 3, outs: { out: 3 }, errors: 0, note: null, standing: [] }]));

    draw();

    expect(await screen.findByText('3 runs')).toBeInTheDocument();
    expect(screen.getAllByText('not running')).toHaveLength(2);
    expect(screen.queryByText('waiting')).toBeNull();
  });

  it('marks a node and a wire the server said are wrong, the node with its reason', async () => {
    draw(button, { 'node:test': ['Pick a test.'], 'edge:e1': ['Not this wire.'] });

    const refused = await screen.findByTitle('Pick a test.');
    expect(refused).toHaveAttribute('data-problem');
    expect(screen.getByLabelText('Edge from start to test').querySelector('.react-flow__edge-path')).toHaveAttribute('data-problem');
    expect(screen.getByText('Start').closest('[data-group]')).not.toHaveAttribute('data-problem');
  });

  it('adds a node where a palette item is dropped, and picks it', async () => {
    draw();
    await screen.findByText('If');

    const canvas = document.getElementById('flow-canvas')!;
    const data = new Map<string, string>([[DRAG_TYPE, 'debug']]);
    const dataTransfer = {
      types: [DRAG_TYPE],
      getData: (type: string) => data.get(type) ?? '',
      dropEffect: 'none',
    };

    act(() => {
      fireEvent.dragOver(canvas, { dataTransfer });
      fireEvent.drop(canvas, { dataTransfer, clientX: 200, clientY: 200 });
    });

    const draft = useFlowDraftStore.getState().drafts.button;
    expect(draft.nodes.map((node) => node.type)).toEqual(['start', 'if', 'end', 'debug']);
    expect(useFlowDraftStore.getState().selected).toBe(draft.nodes[3].id);
  });

  it('lights a wire when the node it leaves sends something down it', async () => {
    const status = (sent: number) => active([{ id: 'start', count: sent, outs: { out: sent }, errors: 0, note: null, standing: [] }]);
    useFlowStatusStore.getState().setStatus(status(1));
    draw();
    await screen.findByText('If');

    act(() => useFlowStatusStore.getState().setStatus(status(2)));

    expect(document.querySelector('[data-flash]')).not.toBeNull();
    expect(useFlowStatusStore.getState().nodes[nodeKey('button', 'start')].outs.out).toBe(2);
  });

  // Pushes come four times a second, each with a new object for every node, and a flow can hold
  // two hundred nodes. A node draws again only when what it shows of its numbers has moved.
  it('draws a node again only when what it shows of its numbers moved', async () => {
    const status = (runs: number) =>
      active([
        { id: 'start', count: runs, outs: { out: runs }, errors: 0, note: null, standing: [] },
        { id: 'test', count: 5, outs: { yes: 2, no: 3 }, errors: 0, note: null, standing: [] },
      ]);
    useFlowStatusStore.getState().setStatus(status(3));
    const start = vi.spyOn(NODE_SPECS.start, 'summary');
    const branch = vi.spyOn(NODE_SPECS.if, 'summary');
    draw();
    await screen.findByText('3 runs');
    start.mockClear();
    branch.mockClear();

    act(() => useFlowStatusStore.getState().setStatus(status(3)));
    const again = { start: start.mock.calls.length, branch: branch.mock.calls.length };

    act(() => useFlowStatusStore.getState().setStatus(status(4)));
    const moved = { start: start.mock.calls.length, branch: branch.mock.calls.length };
    start.mockRestore();
    branch.mockRestore();

    expect(again).toEqual({ start: 0, branch: 0 });
    expect(screen.getByText('4 runs')).toBeInTheDocument();
    expect(moved).toEqual({ start: 1, branch: 0 });
  });

  // A wire drawn or taken away changes what a node draws only where it changes one of its marks — a
  // way out left with no wire, a node no longer reached from the Start — or the ports of a node of a
  // type this build does not know, which takes its ports from its wires. A flow holds up to two
  // hundred nodes, and each connect and each delete drew every one of them again.
  describe('a wire drawn or taken away', () => {
    const start = () => vi.spyOn(NODE_SPECS.start, 'summary');
    const branch = () => vi.spyOn(NODE_SPECS.if, 'summary');

    /** A few turns of the clock, for the canvas to measure what it drew and draw it again. */
    const settled = async () => {
      for (let turn = 0; turn < 5; turn++) await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    };

    it('draws no node again but the one that takes its ports from its wires', async () => {
      // The If's yes goes on to a node of a type this build does not know, and that node on to the End.
      const odd: FlowDto = {
        ...button,
        nodes: [...button.nodes, { id: 'fn', type: 'function', x: 450, y: -80, config: {} }],
        edges: [
          ...button.edges.map((edge) => (edge.id === 'e2' ? { ...edge, to: 'fn' } : edge)),
          { id: 'e4', from: 'fn', fromPort: 'out', to: 'end', toPort: 'in' },
        ],
      };
      const [begin, test] = [start(), branch()];
      drawPage(odd);
      await screen.findByLabelText('Edge from test to fn');
      await settled();
      begin.mockClear();
      test.mockClear();

      const edit = (change: (flow: FlowDto) => FlowDto) => act(() => useFlowDraftStore.getState().edit(odd, change));
      edit((flow) => removeEdges(flow, ['e4']));
      // In place of the wire the yes had: the If's way out is wired all along.
      edit((flow) => connect(flow, { from: 'test', fromPort: 'yes', to: 'end', toPort: 'in' }));
      await settled();
      const drawn = { start: begin.mock.calls.length, branch: test.mock.calls.length };
      begin.mockRestore();
      test.mockRestore();

      expect(drawn).toEqual({ start: 0, branch: 0 });
      // The yes and the no, both to the End now.
      expect(screen.getAllByLabelText('Edge from test to end')).toHaveLength(2);
      // The node that takes its ports from its wires lost both the ones its wires met.
      expect(document.querySelectorAll('.react-flow__handle[data-nodeid="fn"]')).toHaveLength(0);
    });

    it('draws no node again when a picked wire is taken away with the Delete key', async () => {
      // A Debug on the If's yes: taking its wire to the End away leaves the Start and the If as they were.
      const said: FlowDto = {
        ...button,
        nodes: [...button.nodes, { id: 'say', type: 'debug', x: 450, y: -80, config: {} }],
        edges: [
          ...button.edges.map((edge) => (edge.id === 'e2' ? { ...edge, to: 'say' } : edge)),
          { id: 'e4', from: 'say', fromPort: 'out', to: 'end', toPort: 'in' },
        ],
      };
      const [begin, test] = [start(), branch()];
      drawPage(said);
      const wire = await screen.findByLabelText('Edge from say to end');
      await settled();
      fireEvent.click(wire);
      act(() => wire.focus());
      await settled();
      begin.mockClear();
      test.mockClear();

      fireEvent.keyDown(wire, { key: 'Delete' });
      await waitFor(() => expect(wire.isConnected).toBe(false));
      await settled();
      const drawn = { start: begin.mock.calls.length, branch: test.mock.calls.length };
      begin.mockRestore();
      test.mockRestore();

      expect(drawn).toEqual({ start: 0, branch: 0 });
      expect(wireIds()).toEqual(['e1', 'e2', 'e3']);
    });
  });

  it('does not light a wire when its count starts again from nothing', async () => {
    const status = (sent: number) => active([{ id: 'start', count: sent, outs: { out: sent }, errors: 0, note: null, standing: [] }]);
    useFlowStatusStore.getState().setStatus(status(5));
    draw();
    await screen.findByText('If');

    // A deploy restarts the flow and its numbers with it, and a stopped flow has none at all.
    // Neither is a message going down the wire.
    act(() => useFlowStatusStore.getState().setStatus(status(0)));
    expect(document.querySelector('[data-flash]')).toBeNull();

    act(() => useFlowStatusStore.getState().setStatus(status(3)));
    act(() => useFlowStatusStore.getState().setStatus({ runs: [] }));
    await waitFor(() => expect(document.querySelector('[data-flash]')).toBeNull());
  });

  it('lights the wire of the port a message left by, and no other', async () => {
    const branches: FlowDto = {
      ...button,
      nodes: [
        ...button.nodes,
        { id: 'hot', type: 'debug', x: 450, y: -40, config: {} },
        { id: 'cold', type: 'debug', x: 450, y: 200, config: {} },
      ],
      edges: [
        button.edges[0],
        { id: 'e2', from: 'test', fromPort: 'yes', to: 'hot', toPort: 'in' },
        { id: 'e3', from: 'test', fromPort: 'no', to: 'cold', toPort: 'in' },
        { id: 'e4', from: 'hot', fromPort: 'out', to: 'end', toPort: 'in' },
        { id: 'e5', from: 'cold', fromPort: 'out', to: 'end', toPort: 'in' },
      ],
    };
    const status = (yes: number, no: number, count = yes + no) =>
      active([{ id: 'test', count, outs: { yes, no }, errors: 0, note: null, standing: [] }]);
    const lit = (to: string) => screen.getByLabelText(`Edge from test to ${to}`).querySelector('[data-flash]') !== null;
    useFlowStatusStore.getState().setStatus(status(1, 1));
    draw(branches);
    await screen.findAllByText('Debug');

    // What the If took in says nothing about which way it sent it.
    act(() => useFlowStatusStore.getState().setStatus(status(1, 1, 9)));
    expect(lit('hot')).toBe(false);
    expect(lit('cold')).toBe(false);

    act(() => useFlowStatusStore.getState().setStatus(status(1, 2)));
    expect(lit('cold')).toBe(true);
    expect(lit('hot')).toBe(false);

    act(() => useFlowStatusStore.getState().setStatus(status(2, 2)));
    expect(lit('hot')).toBe(true);
  });

  // The marks on a wire are one attribute each, at the same weight, so where two meet the one
  // written later wins: a flash after a pick, so a picked wire still lights, and a refusal after
  // both, so a busy wire cannot hide what the server refused.
  it('lets a picked wire light, and keeps a refused one marked while it does', () => {
    const rules = withoutComments(sheet);
    const at = (mark: string) => rules.indexOf(`.wire[data-${mark}]`);

    expect(at('selected')).toBeGreaterThan(-1);
    expect(at('flash')).toBeGreaterThan(at('selected'));
    expect(at('problem')).toBeGreaterThan(at('flash'));
  });

  // A node the server refused and the reader has picked wears both marks. Drawn with the same
  // properties, the refusal, written later, took the pick's place, and the pick was gone. Each is
  // a shape of its own instead: the pick a ring standing off the node, the refusal its own edge.
  it('keeps the pick on a node the server refused, each mark a shape of its own', () => {
    const rules = withoutComments(sheet);
    const set = (mark: string) =>
      [...(new RegExp(String.raw`\.node\[data-${mark}\]\s*\{([^}]*)\}`).exec(rules)?.[1] ?? '').matchAll(/([\w-]+)\s*:/g)].map(
        ([, property]) => property,
      );

    expect(set('selected')).toContain('outline-offset');
    expect(set('problem')).not.toEqual([]);
    expect(set('problem').filter((property) => set('selected').includes(property))).toEqual([]);
  });

  // A wire that was clicked has the focus as well as the pick, and React Flow draws a focused wire
  // in its own selected colour by a rule that outweighs the marks above. It reads that colour from
  // a variable, so a lit wire and a refused one say their colour there too.
  it('keeps a clicked wire lit, and a refused one red', () => {
    const rules = withoutComments(sheet);
    const body = (mark: string) => new RegExp(String.raw`\.wire\[data-${mark}\]\s*\{([^}]*)\}`).exec(rules)?.[1] ?? '';

    expect(body('flash')).toMatch(/--xy-edge-stroke-selected:\s*var\(--signal\)/);
    expect(body('problem')).toMatch(/--xy-edge-stroke-selected:\s*var\(--fault\)/);
  });

  // React Flow tells the canvas about one click in two reports, the nodes' and the wires', one
  // straight after the other. The second has to start from where the first left the picks.
  it('moves the pick from a node to a wire and back, and the inspector follows the node', async () => {
    draw();
    await screen.findByText('If');
    const node = () => screen.getByText('If').closest('[data-group]')!;
    const wire = () => screen.getByLabelText('Edge from start to test');
    const line = () => wire().querySelector('.react-flow__edge-path')!;

    fireEvent.click(node());
    expect(node()).toHaveAttribute('data-selected');
    expect(useFlowDraftStore.getState().selected).toBe('test');

    fireEvent.click(wire());
    expect(line()).toHaveAttribute('data-selected');
    expect(node()).not.toHaveAttribute('data-selected');
    expect(useFlowDraftStore.getState().selected).toBeNull();

    fireEvent.click(node());
    expect(node()).toHaveAttribute('data-selected');
    expect(line()).not.toHaveAttribute('data-selected');
    expect(useFlowDraftStore.getState().selected).toBe('test');
  });

  // The server checks node ids against node ids and wire ids against wire ids, so a flow written
  // by hand can give a wire the id of a node.
  it('picks a wire without framing a node that shares its id', async () => {
    draw({ ...button, edges: [{ ...button.edges[0], id: 'start' }] });
    await screen.findByText('If');

    fireEvent.click(screen.getByLabelText('Edge from start to test'));

    expect(screen.getByLabelText('Edge from start to test').querySelector('.react-flow__edge-path')).toHaveAttribute('data-selected');
    expect(screen.getByText('Start').closest('[data-group]')).not.toHaveAttribute('data-selected');
  });

  // The keys go where the reader's click put the keyboard: on the wire or the node that was clicked.
  it('takes a picked wire out of the draft when Delete is pressed', async () => {
    draw();
    await screen.findByText('If');
    const wire = screen.getByLabelText('Edge from start to test');

    fireEvent.click(wire);
    fireEvent.keyDown(wire, { key: 'Delete' });
    fireEvent.keyUp(wire, { key: 'Delete' });

    await waitFor(() => expect(wireIds()).toEqual(['e2', 'e3']));
    expect(useFlowDraftStore.getState().drafts.button.nodes.map((node) => node.id)).toEqual(['start', 'test', 'end']);
  });

  // The If has two ways out, so which one the run should have gone on by is the reader's to say:
  // nothing is joined over it, and its wires go with it.
  it('takes a picked node out of the draft with its wires, and the inspector lets it go', async () => {
    draw();
    const picked = await screen.findByText('If');

    fireEvent.click(picked);
    expect(useFlowDraftStore.getState().selected).toBe('test');
    fireEvent.keyDown(picked, { key: 'Backspace' });
    fireEvent.keyUp(picked, { key: 'Backspace' });

    await waitFor(() => expect(useFlowDraftStore.getState().drafts.button?.nodes.map((node) => node.id)).toEqual(['start', 'end']));
    expect(useFlowDraftStore.getState().drafts.button.edges).toEqual([]);
    expect(useFlowDraftStore.getState().selected).toBeNull();
  });

  // Discard puts back what the draft took away. It has to come back as the deployed flow has it,
  // not picked, or the next Backspace takes it away again without the reader seeing it chosen.
  it('lets go of a deleted node, so Discard brings it back unpicked', async () => {
    drawPage();
    const picked = await screen.findByText('If');

    fireEvent.click(picked);
    fireEvent.keyDown(picked, { key: 'Backspace' });
    fireEvent.keyUp(picked, { key: 'Backspace' });
    await waitFor(() => expect(useFlowDraftStore.getState().drafts.button?.nodes.map((node) => node.id)).toEqual(['start', 'end']));

    act(() => useFlowDraftStore.getState().discard('button'));
    expect((await screen.findByText('If')).closest('[data-group]')).not.toHaveAttribute('data-selected');

    // Still in the canvas, where a Backspace would take whatever was picked.
    const canvas = document.getElementById('flow-canvas')!;
    fireEvent.keyDown(canvas, { key: 'Backspace' });
    fireEvent.keyUp(canvas, { key: 'Backspace' });
    // Give anything the key set going a turn before saying it took nothing.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(useFlowDraftStore.getState().drafts.button).toBeUndefined();
  });

  // Discard also clears the inspector. The canvas has to agree, or it frames a node the inspector
  // is not showing.
  it('lets go of a picked node when its draft is discarded', async () => {
    drawPage();
    const start = (await screen.findByText('Start')).closest<HTMLElement>('.react-flow__node')!;

    fireEvent.click(start);
    fireEvent.keyDown(start, { key: 'ArrowRight' });
    expect(useFlowDraftStore.getState().drafts.button).toBeDefined();

    act(() => useFlowDraftStore.getState().discard('button'));

    expect(useFlowDraftStore.getState().selected).toBeNull();
    expect(screen.getByText('Start').closest('[data-group]')).not.toHaveAttribute('data-selected');
    expect(start.style.transform).toBe('translate(0px,80px)');
  });

  // Taken out from among several picked nodes, the node the inspector shows gives way to another
  // still picked, and the canvas keeps that one framed. The Start is never taken out, so picked
  // with the If, it is what is left.
  it('shows another picked node when the one on show is taken out', async () => {
    drawPage();
    // React Flow picks more than one with Meta on a Mac and with Control anywhere else.
    const more = navigator.userAgent.includes('Mac') ? 'Meta' : 'Control';

    fireEvent.click(await screen.findByText('Start'));
    fireEvent.keyDown(window, { key: more });
    fireEvent.click(screen.getByText('If'));
    fireEvent.keyUp(window, { key: more });
    expect(useFlowDraftStore.getState().selected).toBe('test');

    fireEvent.keyDown(document.getElementById('flow-canvas')!, { key: 'Delete' });

    await waitFor(() => expect(useFlowDraftStore.getState().selected).toBe('start'));
    expect(useFlowDraftStore.getState().drafts.button.nodes.map((node) => node.id)).toEqual(['start', 'end']);
    expect(screen.getByText('Start').closest('[data-group]')).toHaveAttribute('data-selected');
  });

  it('lets go of a picked wire that leaves the flow some other way', async () => {
    drawPage();
    await screen.findByText('If');

    fireEvent.click(screen.getByLabelText('Edge from start to test'));
    // Not through the canvas: the flow simply stops having the wire, and then has it again.
    act(() => useFlowDraftStore.getState().edit(button, (flow) => removeEdges(flow, ['e1'])));
    act(() => useFlowDraftStore.getState().discard('button'));

    const wire = screen.getByLabelText('Edge from start to test').querySelector('.react-flow__edge-path')!;
    expect(wire).not.toHaveAttribute('data-selected');
  });

  // Clicking one port and then another is React Flow's other way of drawing a wire, and it asks
  // the same question a dragged wire does before it lands. A way out has one wire, so the new one
  // takes the place of the wire it had.
  it('draws a wire from one port to another in place of the one its way out had, and refuses one the server would refuse', async () => {
    draw({ ...button, nodes: [...button.nodes, { id: 'print', type: 'debug', x: 450, y: -80, config: {} }] });
    await screen.findByText('Debug');

    // Out of the If and straight back into it is a circle, which the server refuses.
    fireEvent.click(port('test', 'yes'));
    fireEvent.click(port('test', 'in'));
    expect(useFlowDraftStore.getState().drafts.button).toBeUndefined();

    fireEvent.click(port('test', 'yes'));
    fireEvent.click(port('print', 'in'));
    expect(useFlowDraftStore.getState().drafts.button.edges).toEqual([
      button.edges[0],
      button.edges[2],
      { id: expect.any(String), from: 'test', fromPort: 'yes', to: 'print', toPort: 'in' },
    ]);
  });

  // A mouse drag moves a node with the same change the arrow keys make. The drag itself cannot be
  // driven here: jsdom lays nothing out, so the canvas is zero pixels wide to React Flow's pan-at-
  // the-edge, which then pans on every drag and moves the node by however long the test took.
  it('moves a picked node with the arrow keys, and draws it where the draft now has it', async () => {
    drawPage();
    const node = (await screen.findByText('Start')).closest<HTMLElement>('.react-flow__node')!;

    fireEvent.click(node);
    fireEvent.keyDown(node, { key: 'ArrowRight' });

    expect(useFlowDraftStore.getState().drafts.button.nodes[0]).toMatchObject({ id: 'start', x: 8, y: 80 });
    expect(node.style.transform).toBe('translate(8px,80px)');
  });

  it('puts a dropped node where the pointer let it go', async () => {
    draw();
    await screen.findByText('If');

    const dataTransfer = { types: [DRAG_TYPE], getData: () => 'debug', dropEffect: 'none' };
    fireEvent.drop(document.getElementById('flow-canvas')!, { dataTransfer, clientX: 200, clientY: 120 });

    // Where the new node's corner is drawn: its place on the canvas, through the canvas's pan and
    // zoom. That is the drop point, to the nearest step of the 8-pixel grid.
    const { x, y } = useFlowDraftStore.getState().drafts.button.nodes[3];
    const [panX, panY, zoom] = viewport();
    expect(Math.abs(panX + x * zoom - 200)).toBeLessThanOrEqual(4 * zoom);
    expect(Math.abs(panY + y * zoom - 120)).toBeLessThanOrEqual(4 * zoom);
  });

  // A key on a control of the canvas's own — a button of the zoom panel in its corner — is that
  // control's, and not about what is picked: left to the canvas, a Backspace there would take away
  // whatever is picked, quite possibly a node panned out of sight a while ago.
  it('leaves what is picked alone when Backspace is pressed on a button of the canvas', async () => {
    draw();
    const picked = await screen.findByText('If');

    fireEvent.click(picked);
    expect(useFlowDraftStore.getState().selected).toBe('test');

    const fit = screen.getByRole('button', { name: 'Fit View' });
    act(() => fit.focus());
    fireEvent.keyDown(fit, { key: 'Backspace' });
    fireEvent.keyUp(fit, { key: 'Backspace' });
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));

    expect(useFlowDraftStore.getState().drafts.button).toBeUndefined();
  });

  // A plain div takes no keyboard at all, with or without this: a browser only follows a click's
  // focus onto an element that a tabIndex, at any value, makes focusable in the first place. A
  // pan is a click on the ground that never lands on a node, so without it the ground stays
  // unable to take the keyboard, wherever a click left it before — off the canvas entirely once
  // that earlier target is gone — and Delete stops reaching the canvas after such a pan. -1 and
  // not 0: a reader moving focus forward with Tab should land on a node, not on the canvas
  // around it.
  it('can take the keyboard by a click, though it is not itself a tab stop', async () => {
    draw();
    await screen.findByText('If');
    const canvas = document.getElementById('flow-canvas')!;

    // Read off the attribute, not the DOM property: an element's tabIndex property defaults to
    // -1 as soon as it is not natively focusable, whether or not it was ever given the attribute.
    expect(canvas.getAttribute('tabindex')).toBe('-1');
    act(() => canvas.focus());
    expect(document.activeElement).toBe(canvas);
  });

  // There is nothing to type into on the canvas today, but the check stands ready for a node
  // type that puts one there, and is worth pinning on its own: without it, this box would lose
  // letters to Backspace and the node picked before it to Delete both at once.
  it('leaves what is picked alone when Backspace is typed into a box on the canvas', async () => {
    draw();
    const picked = await screen.findByText('If');

    fireEvent.click(picked);
    expect(useFlowDraftStore.getState().selected).toBe('test');

    const box = document.createElement('input');
    document.getElementById('flow-canvas')!.appendChild(box);
    fireEvent.keyDown(box, { key: 'Backspace' });
    fireEvent.keyUp(box, { key: 'Backspace' });
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));

    expect(useFlowDraftStore.getState().drafts.button).toBeUndefined();
  });

  // Ctrl+Backspace, say, is a browser or OS shortcut passing through the canvas, not a request to
  // delete a node — the same reasoning a held Alt, Meta or Shift gets.
  it('leaves what is picked alone when Backspace is held with Ctrl', async () => {
    draw();
    const picked = await screen.findByText('If');

    fireEvent.click(picked);
    expect(useFlowDraftStore.getState().selected).toBe('test');

    fireEvent.keyDown(picked, { key: 'Backspace', ctrlKey: true });
    fireEvent.keyUp(picked, { key: 'Backspace', ctrlKey: true });
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));

    expect(useFlowDraftStore.getState().drafts.button).toBeUndefined();
  });
});

/** Puts up the box React Flow draws round nodes picked together, as a drag across them does. */
function BoxThem() {
  const drawing = useStoreApi();
  return (
    <button type="button" onClick={() => drawing.setState({ nodesSelectionActive: true })}>
      Box them
    </button>
  );
}

/**
 * A delete key takes away what the keyboard may be on: the node, a wire of it, the box round nodes
 * picked together. A browser hands the focus of an element taken out to the body, and the next key
 * would miss the canvas, so the keyboard stays in the canvas instead.
 */
describe('where the keyboard goes when a key takes something away', () => {
  const canvas = () => document.getElementById('flow-canvas');
  const ids = () => useFlowDraftStore.getState().drafts.button?.nodes.map((node) => node.id);

  it('stays in the canvas when Backspace takes away the node it was on', async () => {
    drawPage();
    const node = (await screen.findByText('If')).closest<HTMLElement>('.react-flow__node')!;

    fireEvent.click(node);
    act(() => node.focus());
    fireEvent.keyDown(node, { key: 'Backspace' });

    await waitFor(() => expect(node.isConnected).toBe(false));
    expect(ids()).toEqual(['start', 'end']);
    expect(document.activeElement).toBe(canvas());
  });

  it('stays in the canvas when Delete takes away the wire it was on', async () => {
    drawPage();
    await screen.findByText('If');
    const wire = screen.getByLabelText('Edge from start to test');

    fireEvent.click(wire);
    act(() => wire.focus());
    fireEvent.keyDown(wire, { key: 'Delete' });

    await waitFor(() => expect(wire.isConnected).toBe(false));
    expect(wireIds()).toEqual(['e2', 'e3']);
    expect(document.activeElement).toBe(canvas());
  });

  it('stays in the canvas when the box round nodes picked together goes with them', async () => {
    render(
      <ReactFlowProvider>
        <div style={{ width: 800, height: 600 }}>
          <Page flow={button} />
        </div>
        <BoxThem />
      </ReactFlowProvider>,
    );
    const more = navigator.userAgent.includes('Mac') ? 'Meta' : 'Control';
    fireEvent.click(await screen.findByText('Start'));
    fireEvent.keyDown(window, { key: more });
    fireEvent.click(screen.getByText('If'));
    fireEvent.keyUp(window, { key: more });

    fireEvent.click(screen.getByRole('button', { name: 'Box them' }));
    const box = await waitFor(() => document.querySelector<HTMLElement>('.react-flow__nodesselection-rect')!);
    await waitFor(() => expect(document.activeElement).toBe(box));
    fireEvent.keyDown(box, { key: 'Backspace' });

    await waitFor(() => expect(box.isConnected).toBe(false));
    // The Start stays, picked or not: every run begins there.
    expect(ids()).toEqual(['start', 'end']);
    expect(document.activeElement).toBe(canvas());
  });

  // Only what goes takes the keyboard with it. A node it was on that stays, stays on.
  it('leaves the keyboard on a node that is not taken away', async () => {
    drawPage();
    const start = (await screen.findByText('Start')).closest<HTMLElement>('.react-flow__node')!;

    const branch = screen.getByText('If').closest<HTMLElement>('.react-flow__node')!;
    fireEvent.click(branch);
    act(() => start.focus());
    fireEvent.keyDown(start, { key: 'Backspace' });

    await waitFor(() => expect(branch.isConnected).toBe(false));
    expect(ids()).toEqual(['start', 'end']);
    expect(document.activeElement).toBe(start);
  });
});

describe('a flowchart on the canvas', () => {
  it('draws each node in its shape, the decision as a diamond', async () => {
    draw();

    await waitFor(() => expect(document.querySelector('[data-id="test"] [data-shape]')).not.toBeNull());
    expect(document.querySelector('[data-id="start"] [data-shape]')!.getAttribute('data-shape')).toBe('terminal');
    expect(document.querySelector('[data-id="test"] [data-shape]')!.getAttribute('data-shape')).toBe('decision');
    expect(document.querySelector('[data-id="test"] polygon')!.getAttribute('points')).toBe('50,0 100,50 50,100 0,50');
  });

  it('puts each port on its side, and names the ways out of a node with two', async () => {
    draw();

    await waitFor(() => expect(port('test', 'no')).not.toBeNull());
    expect(port('test', 'in').getAttribute('data-side')).toBe('left');
    expect(port('test', 'yes').getAttribute('data-side')).toBe('right');
    expect(port('test', 'no').getAttribute('data-side')).toBe('bottom');
    expect(screen.getByText('yes')).toBeInTheDocument();
    expect(screen.getByText('no')).toBeInTheDocument();
  });

  it('marks a way out with no wire, and a node nothing leads to', async () => {
    const { unmount } = draw({ ...button, edges: button.edges.filter((edge) => edge.id !== 'e3') });

    await waitFor(() => expect(screen.getByText('no · wire me')).toBeInTheDocument());
    expect(port('test', 'no').hasAttribute('data-unwired')).toBe(true);
    unmount();

    // The canvas draws the draft, and the run runs the saved copy, which may still reach the node:
    // what the run says of it stays, after `not reached`, which is this drawing's word for it. A node
    // the run says nothing of says only that.
    useFlowStatusStore
      .getState()
      .setStatus(active([{ id: 'test', count: 5, outs: { yes: 2, no: 3 }, errors: 1, note: 'no such field', standing: [] }]));
    draw({ ...button, edges: button.edges.filter((edge) => edge.id !== 'e1') });
    await waitFor(() => expect(document.querySelector('[data-id="test"] [data-unreached]')).not.toBeNull());

    // In words as well as faded, for a reader who cannot see the fade or point at the node.
    const line = within(document.querySelector<HTMLElement>('[data-id="test"]')!).getByText('not reached · yes 2 · no 3 · 1 error');
    expect(line).toHaveAttribute('data-errors');
    expect(line).toHaveAttribute('title', 'no such field');
    expect(within(document.querySelector<HTMLElement>('[data-id="end"]')!).getByText('not reached')).toBeInTheDocument();
    expect(screen.getAllByText('not reached')).toHaveLength(1);
  });

  // A run can be at a node the draft no longer reaches: what it waits for there is still what it
  // waits for.
  it('says what the run waits for at a node this drawing does not reach, after saying it does not reach it', async () => {
    useFlowStatusStore.getState().setStatus(active([], 'test', { until: null, filter: 'plant/+/temp' }));
    draw({ ...button, edges: button.edges.filter((edge) => edge.id !== 'e1') });
    await waitFor(() => expect(document.querySelector('[data-id="test"] [data-unreached]')).not.toBeNull());

    expect(within(document.querySelector<HTMLElement>('[data-id="test"]')!).getByText('not reached · waiting for a message')).toBeInTheDocument();
    expect(document.querySelector('[data-id="test"] [data-here]')).not.toBeNull();
  });

  it('marks a loop nothing comes back to at its next', async () => {
    const loop: FlowDto = {
      ...button,
      nodes: [button.nodes[0], { id: 'round', type: 'for', x: 300, y: 80, config: { times: '3', forever: false } }, button.nodes[2]],
      edges: [
        { id: 'e1', from: 'start', fromPort: 'out', to: 'round', toPort: 'in' },
        { id: 'e2', from: 'round', fromPort: 'body', to: 'end', toPort: 'in' },
        { id: 'e3', from: 'round', fromPort: 'done', to: 'end', toPort: 'in' },
      ],
    };
    draw(loop);

    await waitFor(() => expect(screen.getByText('next · wire me')).toBeInTheDocument());
    expect(port('round', 'next').hasAttribute('data-unwired')).toBe(true);
  });

  it("writes the first of a node's problems under its name", async () => {
    draw(button, { 'node:test': ['Pick a test.', 'Give it a value.'] });

    await waitFor(() => expect(screen.getByText('Pick a test.')).toBeInTheDocument());
    expect(screen.queryByText('Give it a value.')).toBeNull();
  });

  it('rings the node the run is at, and says it waits for a message there', async () => {
    useFlowStatusStore.getState().setStatus(active([], 'test', { until: null, filter: 'plant/+/temp' }));
    draw();

    await waitFor(() => expect(document.querySelector('[data-id="test"] [data-here]')).not.toBeNull());
    expect(screen.getByText('waiting for a message')).toBeInTheDocument();
  });

  // A run that finished at an End, or was stopped, stays in what the server reports until something
  // replaces it; it is not anywhere any more.
  it('rings no node for a run that has ended', async () => {
    useFlowStatusStore.getState().setStatus({ runs: [runOf('button', { state: 'finished', at: 'end' })] });
    draw();

    await screen.findByText('End');
    expect(document.querySelector('[data-here]')).toBeNull();
  });

  // The marks follow the flow as it is drawn, so a node is handed over again when one of its own
  // changes, though nothing else about it has.
  it('marks a way out once its wire is taken away, and a node once nothing leads to it', async () => {
    drawPage();
    await screen.findByText('If');

    act(() => useFlowDraftStore.getState().edit(button, (flow) => removeEdges(flow, ['e3'])));
    expect(await screen.findByText('no · wire me')).toBeInTheDocument();

    act(() => useFlowDraftStore.getState().edit(button, (flow) => removeEdges(flow, ['e1'])));
    await waitFor(() => expect(document.querySelector('[data-id="test"] [data-unreached]')).not.toBeNull());
  });

  it('counts down the seconds a run waits at a node', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const until = new Date(Date.now() + 2_000).toISOString();
    useFlowStatusStore.getState().setStatus(active([], 'test', { until, filter: null }));
    draw();

    await waitFor(() => expect(screen.getByText(/^2\.0 s left$|^1\.9 s left$/)).toBeInTheDocument());
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(screen.getByText(/^1\.0 s left$|^0\.9 s left$/)).toBeInTheDocument();
    vi.useRealTimers();
  });

  // At nothing left there is nothing more to count until a push says where the run went, and a
  // countdown that went on ticking drew the same 0.0 ten times a second until then.
  it('stops counting when no time is left, and counts the next wait from when it comes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const until = new Date(Date.now() + 500).toISOString();
    useFlowStatusStore.getState().setStatus(active([], 'test', { until, filter: null }));
    let drawn = 0;
    render(
      <Profiler id="canvas" onRender={() => drawn++}>
        <ReactFlowProvider>
          <div style={{ width: 800, height: 600 }}>
            <FlowCanvas flow={button} problems={{}} />
          </div>
        </ReactFlowProvider>
      </Profiler>,
    );

    await act(async () => vi.advanceTimersByTime(1_000));
    expect(screen.getByText('0.0 s left')).toBeInTheDocument();

    // A second more, a tenth at a time, as a countdown that ticks on would draw it.
    drawn = 0;
    for (let tenth = 0; tenth < 10; tenth++) await act(async () => vi.advanceTimersByTime(100));

    expect(drawn).toBe(0);
    expect(screen.getByText('0.0 s left')).toBeInTheDocument();

    // The run goes round and waits there again, a while later: counted from then, not from where
    // the last wait stopped.
    await act(async () => vi.advanceTimersByTime(3_000));
    const again = new Date(Date.now() + 2_000).toISOString();
    act(() => useFlowStatusStore.getState().setStatus(active([], 'test', { until: again, filter: null })));

    expect(screen.getByText(/^2\.0 s left$|^1\.9 s left$/)).toBeInTheDocument();
  });

  it('says not running under a node no run reports', async () => {
    draw();

    await waitFor(() => expect(screen.getAllByText('not running')).toHaveLength(3));
  });

  it('joins what came before a node to what came after when Delete takes it out', async () => {
    const line: FlowDto = {
      ...button,
      nodes: [button.nodes[0], { id: 'say', type: 'debug', x: 300, y: 80, config: {} }, button.nodes[2]],
      edges: [
        { id: 'e1', from: 'start', fromPort: 'out', to: 'say', toPort: 'in' },
        { id: 'e2', from: 'say', fromPort: 'out', to: 'end', toPort: 'in' },
      ],
    };
    useFlowDraftStore.getState().show('button');
    render(
      <ReactFlowProvider>
        <div style={{ width: 800, height: 600 }}>
          <Page flow={line} />
        </div>
      </ReactFlowProvider>,
    );

    await waitFor(() => expect(document.querySelector('[data-id="say"]')).not.toBeNull());
    fireEvent.click(document.querySelector('[data-id="say"]')!);
    fireEvent.keyDown(document.getElementById('flow-canvas')!, { key: 'Delete' });

    const draft = useFlowDraftStore.getState().drafts.button;
    expect(draft.nodes.map((node) => node.id)).toEqual(['start', 'end']);
    expect(draft.edges.map((edge) => `${edge.from}>${edge.to}`)).toEqual(['start>end']);
  });

  // Wires first: the way on of a step that goes, picked with it, is meant gone, so the wire into the
  // step is not carried over it to where that way on went.
  it('takes a picked wire out before the step it leaves, and joins nothing over the step', async () => {
    const line: FlowDto = {
      ...button,
      nodes: [button.nodes[0], { id: 'say', type: 'debug', x: 300, y: 80, config: {} }, button.nodes[2]],
      edges: [
        { id: 'e1', from: 'start', fromPort: 'out', to: 'say', toPort: 'in' },
        { id: 'e2', from: 'say', fromPort: 'out', to: 'end', toPort: 'in' },
      ],
    };
    drawPage(line);
    const more = navigator.userAgent.includes('Mac') ? 'Meta' : 'Control';

    fireEvent.click(await screen.findByText('Debug'));
    fireEvent.keyDown(window, { key: more });
    fireEvent.click(screen.getByLabelText('Edge from say to end'));
    fireEvent.keyUp(window, { key: more });
    fireEvent.keyDown(document.getElementById('flow-canvas')!, { key: 'Delete' });

    const draft = useFlowDraftStore.getState().drafts.button;
    expect(draft.nodes.map((node) => node.id)).toEqual(['start', 'end']);
    expect(draft.edges).toEqual([]);
  });

  // A new flow is a Start wired straight to an End, and its first step goes on that one wire.
  it('says how the first step goes in while the flow is a Start wired straight to an End', async () => {
    const said = 'Pick the wire, then click a node on the left to put it there.';
    const { unmount } = draw();
    await screen.findByText('If');
    expect(screen.queryByText(said)).toBeNull();
    unmount();

    draw({ ...button, nodes: [button.nodes[0], button.nodes[2]], edges: [{ ...button.edges[0], to: 'end' }] });

    expect(await screen.findByText(said)).toBeInTheDocument();
  });

  // A lone way out has no name for the mark to follow. A node nothing leads to says so when it is
  // pointed at, unless the server said what is wrong with it, which matters more.
  it('marks a lone way out with no wire, and says why a node is faded', async () => {
    draw({ ...button, edges: button.edges.filter((edge) => edge.id !== 'e1') }, { 'node:end': ['Nothing comes here.'] });

    await waitFor(() => expect(screen.getByText('wire me')).toBeInTheDocument());
    expect(port('start', 'out').hasAttribute('data-unwired')).toBe(true);
    expect(screen.getByText('If').closest('[data-group]')).toHaveAttribute('title', 'Nothing leads here from Start.');
    expect(screen.getByText('End').closest('[data-group]')).toHaveAttribute('title', 'Nothing comes here.');
  });

  it('never takes the Start out', async () => {
    drawPage();

    await waitFor(() => expect(document.querySelector('[data-id="start"]')).not.toBeNull());
    fireEvent.click(document.querySelector('[data-id="start"]')!);
    fireEvent.keyDown(document.getElementById('flow-canvas')!, { key: 'Backspace' });

    expect(useFlowDraftStore.getState().drafts.button).toBeUndefined();
  });

  it('tells the store which wire is picked, and lets it go when a node is picked', async () => {
    drawPage();

    await waitFor(() => expect(document.querySelector('[data-id="e2"]')).not.toBeNull());
    fireEvent.click(document.querySelector('[data-id="e2"] path')!);
    expect(useFlowDraftStore.getState().wire).toBe('e2');

    fireEvent.click(document.querySelector('[data-id="test"]')!);
    expect(useFlowDraftStore.getState().wire).toBeNull();
  });
});

/**
 * A flow opens fitted to the canvas, unless it is too wide to read fitted: then it opens at the
 * smallest size its text can be read at, from its Start, and the reader pans along it from where every
 * run begins. jsdom lays nothing out, so each node is a pixel square; the pane is given a size.
 */
describe('the view a flow opens in', () => {
  let unsized = () => {};
  let observer: unknown;
  beforeEach(() => {
    unsized = paneSized(800, 600);
    observer = globalThis.ResizeObserver;
    vi.stubGlobal('ResizeObserver', MeasuredTogether);
  });
  afterEach(() => {
    unsized();
    vi.stubGlobal('ResizeObserver', observer);
  });

  /** Start → ten Debugs → End, along a row, 284 apart: as wide as a long chain clicked together. */
  const wide: FlowDto = {
    ...button,
    id: 'wide',
    nodes: [
      { id: 'start', type: 'start', x: 0, y: 100, config: {} },
      ...Array.from({ length: 10 }, (_, at) => ({ id: `d${at + 1}`, type: 'debug', x: 284 * (at + 1), y: 100, config: {} })),
      { id: 'end', type: 'end', x: 284, y: 300, config: {} },
    ],
    edges: ['start', ...Array.from({ length: 10 }, (_, at) => `d${at + 1}`)].map((from, at, all) => ({
      id: `e${at + 1}`,
      from,
      fromPort: 'out',
      to: all[at + 1] ?? 'end',
      toPort: 'in',
    })),
  };

  it('opens a flow too wide to read fitted at 0.6, its Start 40 from the left and its middle halfway down', async () => {
    draw(wide);

    // Fitted, the flow's 2841 across would be at 0.25 in 800, past what can be read.
    await waitFor(() => expect(viewport()[2]).toBe(0.6));
    const [x, y] = viewport();
    // The Start's left edge at 40; the flow from its top, 100, to its foot, 301, about the middle.
    expect(x).toBeCloseTo(40 - 0 * 0.6);
    expect(y).toBeCloseTo(300 - ((100 + 301) / 2) * 0.6);
  });

  // The alarm wall opens the page with the flow's Raise alarm picked, and a node picked before
  // another panel took the canvas away is picked still: shown from its Start, a long flow would leave
  // the node the reader came for out of sight.
  it('opens such a flow on the node picked when the Start leaves it out of view, and from the Start when not', async () => {
    useFlowDraftStore.getState().select('d9');
    const { unmount } = draw(wide);

    await waitFor(() => expect(viewport()[2]).toBe(0.6));
    const [x, y] = viewport();
    // d9 stands at 2556, 100, a pixel square: its middle in the middle of the pane.
    expect(x).toBeCloseTo(400 - 2556.5 * 0.6);
    expect(y).toBeCloseTo(300 - 100.5 * 0.6);
    unmount();

    // 284 is in view from the Start, which shows as far as (800 - 40) / 0.6 = 1266.
    useFlowDraftStore.getState().select('d1');
    draw(wide);
    await waitFor(() => expect(viewport()[2]).toBe(0.6));
    expect(viewport()[0]).toBeCloseTo(40);
  });

  /** Start, then Debugs down a column a row apart, and the End: `rows` rows, the Start on the one `from` says. */
  const column = (rows: number, from = 0): FlowDto => {
    const ids = Array.from({ length: rows - 1 }, (_, at) => `d${at + 1}`);
    return {
      ...button,
      id: 'tall',
      nodes: [
        { id: 'start', type: 'start', x: 0, y: 176 * from, config: {} },
        ...ids.map((id, at) => ({ id, type: 'debug', x: 0, y: 176 * (at < from ? at : at + 1), config: {} })),
        { id: 'end', type: 'end', x: 284, y: 176 * rows, config: {} },
      ],
      edges: ['start', ...ids].map((from, at, all) => ({ id: `e${at + 1}`, from, fromPort: 'out', to: all[at + 1] ?? 'end', toPort: 'in' })),
    };
  };

  // Its rows' middle halfway down, a flow taller than the canvas at 0.6 opened with its top rows,
  // and the Start among them, above the canvas: the one place every run begins was out of sight.
  it('opens a flow too tall to read fitted at 0.6 from its top, its Start in view', async () => {
    draw(column(10));

    await waitFor(() => expect(viewport()[2]).toBe(0.6));
    const [x, y] = viewport();
    // The Start's left edge and the flow's top, where the Start stands, 40 in from the corner.
    expect(x).toBeCloseTo(40);
    expect(y).toBeCloseTo(40);
  });

  it('opens on the Start a flow too tall whose top would leave the Start out of view', async () => {
    draw(column(10, 8));

    await waitFor(() => expect(viewport()[2]).toBe(0.6));
    // The Start's top, 176 × 8 down, 40 from the canvas's top.
    expect(viewport()[1]).toBeCloseTo(40 - 176 * 8 * 0.6);
  });

  it('fits a flow that can be read fitted, as it did', async () => {
    draw({
      ...button,
      nodes: [
        { id: 'start', type: 'start', x: 0, y: 80, config: {} },
        { id: 'test', type: 'if', x: 417, y: 80, config: { field: '$.temp', test: 'gt', value: '90', value2: '' } },
        { id: 'end', type: 'end', x: 834, y: 80, config: {} },
      ],
    });

    // 835 across in 800, less a twelfth of it at each side: 0.8, centred.
    await waitFor(() => expect(viewport()[2]).toBeCloseTo(0.8));
    const [x, y] = viewport();
    expect(x).toBeCloseTo(400 - (835 / 2) * 0.8);
    expect(y).toBeCloseTo(300 - 80.5 * 0.8);
  });
});

/**
 * A wire whose way in stands left of its way out is drawn round what stands between its ends rather
 * than through it (backWires.ts): one that has to climb goes sideways out of its port, up to the lowest
 * lane that clears what it would cross, back along it, and down onto the next or into the way in from
 * its left; one going down to a way in further left runs under the node it leaves; and one out of a
 * foot into a way in to its right, no lower than the foot, goes down, along and up into it.
 *
 * jsdom lays nothing out, so every node here is a pixel square and its ports stand on its corner; the
 * nodes' places are what the routes are worked out from, and what these cases read.
 */
describe('a wire drawn round', () => {
  /**
   * Start → For → Publish, the Publish's wire going back to the For's next, and the For's done on
   * to the End below. `between` puts a Debug, wired to nothing, between the For and the Publish.
   */
  const looping = (between?: { x: number; y: number }): FlowDto => ({
    id: 'looping',
    name: 'Looping',
    enabled: true,
    variables: [],
    nodes: [
      { id: 'start', type: 'start', x: -300, y: 200, config: {} },
      { id: 'round', type: 'for', x: 0, y: 200, config: { times: '3', forever: false } },
      { id: 'send', type: 'publish', x: 400, y: 200, config: { topic: 'plant/k1/cmd', payload: '', qos: 0, retain: false } },
      { id: 'end', type: 'end', x: 100, y: 400, config: {} },
      ...(between ? [{ id: 'say', type: 'debug', x: between.x, y: between.y, config: {} }] : []),
    ],
    edges: [
      { id: 'e1', from: 'start', fromPort: 'out', to: 'round', toPort: 'in' },
      { id: 'e2', from: 'round', fromPort: 'body', to: 'send', toPort: 'in' },
      { id: 'e3', from: 'send', fromPort: 'out', to: 'round', toPort: 'next' },
      { id: 'e4', from: 'round', fromPort: 'done', to: 'end', toPort: 'in' },
    ],
  });

  /** Start → a Debug, its wire on to an End standing where `end` puts it. */
  const ending = (end: { x: number; y: number }): FlowDto => ({
    id: 'again',
    name: 'Again',
    enabled: true,
    variables: [],
    nodes: [
      { id: 'start', type: 'start', x: -300, y: 200, config: {} },
      { id: 'say', type: 'debug', x: 400, y: 200, config: {} },
      { id: 'end', type: 'end', x: end.x, y: end.y, config: {} },
    ],
    edges: [
      { id: 'e1', from: 'start', fromPort: 'out', to: 'say', toPort: 'in' },
      { id: 'e2', from: 'say', fromPort: 'out', to: 'end', toPort: 'in' },
    ],
  });

  /** What a wire's path says, once it is drawn. */
  const pathOf = async (wire: string) => {
    const line = await waitFor(() => {
      const found = document.querySelector(`.react-flow__edge[data-id="${wire}"] .react-flow__edge-path`);
      expect(found).not.toBeNull();
      return found!;
    });
    return line.getAttribute('d')!;
  };

  /**
   * The straight runs of a path, in order, as the points each starts and ends at: an M or the end of
   * the curve before it, to the next L. A rounded corner is a Q, and starts no run of its own.
   */
  function runsOf(d: string) {
    const steps = [...d.matchAll(/([MLQ])\s*((?:-?[\d.e+-]+[ ,]?)+)/g)].map(([, command, numbers]) => {
      const values = numbers.trim().split(/[ ,]+/).map(Number);
      return { command, x: values.at(-2)!, y: values.at(-1)! };
    });
    return steps.flatMap((step, at) => (step.command === 'L' ? [{ from: steps[at - 1], to: step }] : []));
  }

  /** The corners a path turns at: each rounded corner's Q bends round one. */
  const cornersOf = (d: string) =>
    [...d.matchAll(/Q\s*(-?[\d.e+-]+)[ ,]\s*(-?[\d.e+-]+)/g)].map(([, x, y]) => ({ x: Number(x), y: Number(y) }));

  /** The height of a path's longest level run: the lane a wire drawn round runs along. */
  const laneOf = (d: string) =>
    runsOf(d)
      .filter(({ from, to }) => from.y === to.y)
      .sort((a, b) => Math.abs(b.to.x - b.from.x) - Math.abs(a.to.x - a.from.x))[0].from.y;

  it('runs a wire back to a loop over a node it would cross, and down onto the next', async () => {
    drawPage(looping({ x: 200, y: 180 }));
    const d = await pathOf('e3');

    // Square corners rounded, not a curve: no C in it.
    expect(d).not.toContain('C');
    // The Debug's top is at 180, too near the lane the wire would take over the loop: it runs 32 above the Debug.
    expect(laneOf(d)).toBe(180 - 32);

    const runs = runsOf(d);
    // Out of the Publish's way out to the right, level, and in the end straight down onto the next.
    expect(runs[0].from.y).toBe(runs[0].to.y);
    expect(runs[0].to.x).toBeGreaterThan(runs[0].from.x);
    expect(runs.at(-1)!.from.x).toBe(runs.at(-1)!.to.x);
    expect(runs.at(-1)!.to.y).toBeGreaterThan(runs.at(-1)!.from.y);
  });

  // Over every node between its ends, the lane went up for nothing over a node standing wholly above
  // it, and came down again through whatever stood under that node.
  it('runs it under a node standing wholly above its lane, 32 above the loop and its body', async () => {
    drawPage(looping({ x: 200, y: 40 }));

    expect(laneOf(await pathOf('e3'))).toBe(200 - 32);
  });

  // Into a way in, which is on the left of its node: past the node on that side, and in from there.
  it('comes into a way in from its left when the node it climbs back to stands left of the one it leaves', async () => {
    drawPage(ending({ x: 100, y: 200 }));
    const d = await pathOf('e2');
    const [down, into] = runsOf(d).slice(-2);

    expect(laneOf(d)).toBe(200 - 32);
    // Down 24 left of the way in, and then right, level, into it.
    expect(down.from.x).toBe(down.to.x);
    expect(down.to.y).toBeGreaterThan(down.from.y);
    expect(into.from.y).toBe(into.to.y);
    expect(into.to.x - down.to.x).toBe(24);
  });

  // Up over its own node and down again, a wire to a node under it and to its left crossed the row it
  // left twice, for nothing.
  it('takes a wire to a way in further left and lower under the node it leaves, not over it', async () => {
    drawPage(ending({ x: 100, y: 300 }));
    const d = await pathOf('e2');
    const [out, beside, under, into] = cornersOf(d);

    // Out to the margin past the Debug, down to the margin under it, left to the margin before the
    // End's way in, down and into it: never over the Debug's way out.
    expect(out).toEqual({ x: 401 + 24, y: 200.5 });
    expect(beside).toEqual({ x: 401 + 24, y: 201 + 24 });
    expect(under).toEqual({ x: 100 - 24, y: 201 + 24 });
    expect(into).toEqual({ x: 100 - 24, y: 300.5 });
    expect(Math.min(...cornersOf(d).map((corner) => corner.y))).toBeGreaterThanOrEqual(200.5);
  });

  // A way out at the foot of a node goes down first, and round the node's right side, not up through it.
  it('takes a way out at the foot of its node down, then past the node, before it climbs back', async () => {
    drawPage({
      id: 'branch',
      name: 'Branch',
      enabled: true,
      variables: [],
      nodes: [
        { id: 'start', type: 'start', x: -300, y: 200, config: {} },
        { id: 'test', type: 'if', x: 400, y: 200, config: { field: '$.temp', test: 'gt', value: '90', value2: '' } },
        { id: 'say', type: 'debug', x: 0, y: 100, config: {} },
        { id: 'end', type: 'end', x: 700, y: 200, config: {} },
      ],
      edges: [
        { id: 'e1', from: 'start', fromPort: 'out', to: 'test', toPort: 'in' },
        { id: 'e2', from: 'test', fromPort: 'yes', to: 'end', toPort: 'in' },
        { id: 'e3', from: 'test', fromPort: 'no', to: 'say', toPort: 'in' },
        { id: 'e4', from: 'say', fromPort: 'out', to: 'end', toPort: 'in' },
      ],
    });
    const d = await pathOf('e3');
    const start = runsOf(d)[0].from;
    const [below, beside, above] = cornersOf(d);
    const right = document.querySelector<HTMLElement>('.react-flow__node[data-id="test"]')!.offsetWidth + 400;

    // Straight down the margin, right past the node's right edge, and up from there. At least the
    // margin past it: in jsdom the If is a pixel wide, and the names of its ways out, under it and
    // beside it, stand in the margin, so the wire goes up past them too.
    expect(below).toEqual({ x: start.x, y: start.y + 24 });
    expect(beside.y).toBe(below.y);
    expect(beside.x).toBeGreaterThanOrEqual(right + 24);
    expect(above.x).toBe(beside.x);
    expect(above.y).toBeLessThan(start.y);
  });

  // The curve out of a foot turned back up while it was beside its node, and ran through the node's
  // lower corner, or through the step that stood after it on the row.
  it('takes a way out at the foot down, along under the row and up into a way in to its right', async () => {
    drawPage();
    const d = await pathOf('e3');

    expect(d).not.toContain('C');
    // The If's foot is at 300.5, 81: down the margin under the If, right to the margin before the
    // End's way in, and up into it.
    expect(cornersOf(d)).toEqual([
      { x: 300.5, y: 81 + 24 },
      { x: 600 - 24, y: 81 + 24 },
      { x: 600 - 24, y: 80.5 },
    ]);
  });

  // Out of a way out on the right, a wire going back turns up the margin past its port: a name
  // standing where it did, just past the port, had the wire run up through its letters.
  it("stands a side port's name past where a wire going back turns up beside it", async () => {
    const rules = withoutComments(sheet);
    for (const [side, edge] of [['right', 'left'], ['left', 'right']])
      expect(rules).toMatch(
        new RegExp(String.raw`\.port\[data-side='${side}'\]\s*\{[^}]*${edge}:\s*calc\(100% \+ var\(--wire-margin\) \+ 6px\)`),
      );

    draw();
    await screen.findByText('If');
    expect(document.getElementById('flow-canvas')!.style.getPropertyValue('--wire-margin')).toBe(`${backWires.MARGIN}px`);
  });

  it('draws a wire that goes forward as the curve it was', async () => {
    drawPage(looping({ x: 200, y: 180 }));

    expect(await pathOf('e1')).toMatch(/^M\s*-?[\d.]+,\s*-?[\d.]+\s*C/);
    expect(await pathOf('e2')).toMatch(/^M\s*-?[\d.]+,\s*-?[\d.]+\s*C/);
  });

  it('keeps the marks a wire wears when it goes back: picked, lit and refused', async () => {
    const status = (sent: number) =>
      ({ runs: [runOf('looping', { nodes: [{ id: 'send', count: sent, outs: { out: sent }, errors: 0, note: null, standing: [] }] })] }) as FlowStatusDto;
    useFlowStatusStore.getState().setStatus(status(1));
    useFlowDraftStore.getState().show('looping');
    render(
      <ReactFlowProvider>
        <div style={{ width: 800, height: 600 }}>
          <FlowCanvas flow={looping()} problems={{ 'edge:e3': ['Not this wire.'] }} />
        </div>
      </ReactFlowProvider>,
    );
    await pathOf('e3');
    const line = () => document.querySelector('.react-flow__edge[data-id="e3"] .react-flow__edge-path')!;

    act(() => useFlowStatusStore.getState().setStatus(status(2)));
    fireEvent.click(document.querySelector('.react-flow__edge[data-id="e3"]')!);

    expect(line()).toHaveAttribute('data-problem');
    expect(line()).toHaveAttribute('data-flash');
    expect(line()).toHaveAttribute('data-selected');
  });

  // A flow holds up to two hundred nodes, and a drag moves one of them a frame at a time. Where a wire
  // drawn round runs depends on where every node stands and every other such wire runs, so it is
  // worked out for all of them at once; each draws itself again only when its own route moves: not
  // for a node moved out of its way, nor for a push of the numbers.
  it('draws a wire drawn round again only when its own route moves', async () => {
    const flow = looping({ x: 200, y: 180 });
    const drawn = vi.spyOn(backWires, 'backPath');
    drawPage(flow);
    await pathOf('e3');
    for (let turn = 0; turn < 5; turn++) await act(() => new Promise((resolve) => setTimeout(resolve, 0)));

    try {
      drawn.mockClear();
      act(() => useFlowDraftStore.getState().edit(flow, (current) => moveNodes(current, { end: { x: 160, y: 480 } })));
      act(() => useFlowStatusStore.getState().setStatus({ runs: [runOf('looping')] }));
      await waitFor(() => expect(document.querySelector('.react-flow__node[data-id="end"]')).toHaveStyle({ transform: 'translate(160px,480px)' }));
      const still = drawn.mock.calls.length;

      act(() => useFlowDraftStore.getState().edit(flow, (current) => moveNodes(current, { say: { x: 200, y: 150 } })));
      await waitFor(async () => expect(laneOf(await pathOf('e3'))).toBe(150 - 32));

      expect(still).toBe(0);
      expect(drawn).toHaveBeenCalled();
    } finally {
      drawn.mockRestore();
    }
  });

  // The routes are worked out together, and a node moved makes a new plan of all of them; a wire
  // whose own route the plan left as it was is not drawn again for it.
  it('draws again only the wire whose route a moved node changed, not every wire drawn round', async () => {
    const flow = looping({ x: 200, y: 180 });
    // The End down and to the left of the For: its done goes under the For to it, nowhere near the Debug.
    const both = { ...flow, nodes: flow.nodes.map((node) => (node.id === 'end' ? { ...node, x: -200, y: 400 } : node)) };
    const drawn = vi.spyOn(backWires, 'backPath');
    drawPage(both);
    await pathOf('e3');
    await pathOf('e4');
    for (let turn = 0; turn < 5; turn++) await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(document.querySelector('.react-flow__edge[data-id="e4"] .react-flow__edge-path')!.getAttribute('d')).not.toContain('C');

    try {
      drawn.mockClear();
      act(() => useFlowDraftStore.getState().edit(both, (current) => moveNodes(current, { say: { x: 200, y: 150 } })));
      await waitFor(async () => expect(laneOf(await pathOf('e3'))).toBe(150 - 32));

      // Each call draws the wire whose way out it starts at: the Publish's, never the For's done.
      const from = drawn.mock.calls.map(([wire]) => wire.source.x);
      expect(from.length).toBeGreaterThan(0);
      expect(from.every((x) => x === 401)).toBe(true);
    } finally {
      drawn.mockRestore();
    }
  });
});

/**
 * The wire picked alone is where the palette puts the node it adds, so the wire the store names and
 * the wire drawn picked are one: a node put on a wire nobody sees picked, or put free while a wire
 * is plainly picked, is a click that does something other than what the canvas showed.
 */
describe('the wire picked, as the canvas draws it and the store names it', () => {
  /** The wires drawn picked, by id. */
  const wiresPicked = () =>
    [...document.querySelectorAll('.react-flow__edge')].flatMap((edge) =>
      edge.querySelector('.react-flow__edge-path[data-selected]') ? [edge.getAttribute('data-id')] : [],
    );

  /** The canvas drawn again with the flow the store already shows, as the panel draws it when it is opened again. */
  const drawAgain = () =>
    render(
      <ReactFlowProvider>
        <div style={{ width: 800, height: 600 }}>
          <Page flow={button} />
        </div>
      </ReactFlowProvider>,
    );

  it('lets go of the wire picked alone when Discard puts back a flow that has it too', async () => {
    drawPage();
    // A change made a while ago, which Discard takes back: the End moved over.
    act(() => useFlowDraftStore.getState().edit(button, (flow) => moveNodes(flow, { end: { x: 640, y: 80 } })));
    fireEvent.click(await screen.findByLabelText('Edge from start to test'));
    expect(useFlowDraftStore.getState().wire).toBe('e1');

    act(() => useFlowDraftStore.getState().discard('button'));

    expect(useFlowDraftStore.getState().wire).toBeNull();
    expect(wiresPicked()).toEqual([]);
  });

  // A click on the tab of the flow on screen shows it again, with nothing picked.
  it('lets go of the wire picked alone when the flow on screen is shown again', async () => {
    drawPage();
    fireEvent.click(await screen.findByLabelText('Edge from start to test'));
    expect(useFlowDraftStore.getState().wire).toBe('e1');

    act(() => useFlowDraftStore.getState().show('button'));

    expect(useFlowDraftStore.getState().wire).toBeNull();
    expect(wiresPicked()).toEqual([]);
  });

  // Another panel opened takes the canvas away, and the store, which outlives it, still names the
  // wire — as it still names a node chosen, which comes back picked.
  it('picks the wire the store names when the canvas is drawn again', async () => {
    const { unmount } = drawPage();
    fireEvent.click(await screen.findByLabelText('Edge from start to test'));
    unmount();

    drawAgain();

    await waitFor(() => expect(wiresPicked()).toEqual(['e1']));
    expect(useFlowDraftStore.getState().wire).toBe('e1');
  });

  it('names no wire when the canvas is drawn again for a flow that lost it in the meantime', async () => {
    const { unmount } = drawPage();
    fireEvent.click(await screen.findByLabelText('Edge from start to test'));
    unmount();
    // Taken out while the canvas was away: in another tab, whose draft this one takes in.
    act(() => useFlowDraftStore.getState().edit(button, (flow) => removeEdges(flow, ['e1'])));

    drawAgain();

    await waitFor(() => expect(useFlowDraftStore.getState().wire).toBeNull());
    expect(wiresPicked()).toEqual([]);
  });

  // The store can change between a render and the effect after it. The page, showing another flow in
  // place of one that went, tells the store so as the canvas for it is first drawn; read from that
  // render, the wire the gone flow had picked would be picked again here, in a flow that may have a
  // wire of that id too.
  it('follows the wire the store names when the canvas follows it, not the one it named when the canvas was drawn', async () => {
    useFlowDraftStore.setState({ current: 'gone', wire: 'e1' });

    render(
      <ReactFlowProvider>
        <div style={{ width: 800, height: 600 }}>
          <ShownInPlace flow={button} />
        </div>
      </ReactFlowProvider>,
    );

    await screen.findByLabelText('Edge from start to test');
    expect(useFlowDraftStore.getState().wire).toBeNull();
    expect(wiresPicked()).toEqual([]);
  });

  it('names no wire while two are picked', async () => {
    drawPage();
    const more = navigator.userAgent.includes('Mac') ? 'Meta' : 'Control';

    fireEvent.click(await screen.findByLabelText('Edge from start to test'));
    fireEvent.keyDown(window, { key: more });
    fireEvent.click(document.querySelector('.react-flow__edge[data-id="e2"]')!);
    fireEvent.keyUp(window, { key: more });

    expect(wiresPicked()).toEqual(['e1', 'e2']);
    expect(useFlowDraftStore.getState().wire).toBeNull();
  });
});
