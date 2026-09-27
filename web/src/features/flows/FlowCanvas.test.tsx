import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { nodeKey, useFlowStatusStore } from '../../stores/flowStatusStore';
import { server } from '../../test/server';
import { renderWithClient as render } from '../../test/renderWithClient';
import type { FlowDto, FlowStatusDto } from '../../types/api';
import { standInForTheBrowser } from './canvasTestbed';
import { DRAG_TYPE, FlowCanvas } from './FlowCanvas';
import sheet from './FlowCanvas.module.css?raw';
import { removeEdges, type Problems } from './flowDocument';
import { useFlowDraftStore } from './flowDraftStore';
import { NODE_SPECS } from './nodeTypes';

beforeAll(() => standInForTheBrowser());
afterAll(() => vi.unstubAllGlobals());

beforeEach(() => {
  localStorage.clear();
  useFlowDraftStore.setState({ drafts: {}, bases: {}, current: null, selected: null, refusals: {} });
  useFlowStatusStore.setState(useFlowStatusStore.getInitialState());
});

const button: FlowDto = {
  id: 'button',
  name: 'Button',
  enabled: true,
  nodes: [
    { id: 'go', type: 'inject', x: 40, y: 80, config: { topic: 'plant/k1/button', payload: '1' } },
    { id: 'test', type: 'if', x: 300, y: 80, config: { field: '$.temp', test: 'gt', value: '90', value2: '' } },
  ],
  edges: [{ id: 'e1', from: 'go', fromPort: 'out', to: 'test', toPort: 'in' }],
};

const draw = (flow: FlowDto = button, running = true, problems: Problems = {}) =>
  render(
    <ReactFlowProvider>
      <div style={{ width: 800, height: 600 }}>
        <FlowCanvas flow={flow} running={running} problems={problems} />
      </div>
    </ReactFlowProvider>,
  );

/** The canvas as the page draws it: the flow's draft once it has one, the deployed flow until then. */
function Page({ flow }: { flow: FlowDto }) {
  const draft = useFlowDraftStore((state) => state.drafts[flow.id]);
  return <FlowCanvas flow={draft ?? flow} running problems={{}} />;
}

/** The button flow on screen the way the page puts it there, so a Discard redraws the canvas. */
const drawPage = () => {
  useFlowDraftStore.getState().show('button');
  return render(
    <ReactFlowProvider>
      <div style={{ width: 800, height: 600 }}>
        <Page flow={button} />
      </div>
    </ReactFlowProvider>,
  );
};

/** Deletes one node through React Flow, the way something beside the canvas could. */
function DeleteNode({ id }: { id: string }) {
  const { deleteElements } = useReactFlow();
  return (
    <button type="button" onClick={() => void deleteElements({ nodes: [{ id }] })}>
      Delete {id}
    </button>
  );
}

/** A port on the canvas, by its node and its name. */
const port = (nodeId: string, name: string) =>
  document.querySelector<HTMLElement>(`.react-flow__handle[data-nodeid="${nodeId}"][data-handleid="${name}"]`)!;

/** How far the canvas is panned and how far it is zoomed, read off the transform it draws with. */
function viewport(): [number, number, number] {
  const transform = document.querySelector<HTMLElement>('.react-flow__viewport')!.style.transform;
  const [, x, y, zoom] = /translate\((-?[\d.]+)px, ?(-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(transform)!;
  return [Number(x), Number(y), Number(zoom)];
}

describe('flow canvas', () => {
  it('draws each node with its name, its settings and what it has done', async () => {
    useFlowStatusStore.getState().setStatus({
      flows: [{ id: 'button', faults: 0, fault: null, nodes: [{ id: 'test', count: 5, outs: { yes: 2, no: 3 }, errors: 0, note: null, standing: [] }] }],
    });

    draw();

    expect(await screen.findByText('If')).toBeInTheDocument();
    expect(screen.getByText('$.temp > 90')).toBeInTheDocument();
    expect(screen.getByText('yes 2 · no 3')).toBeInTheDocument();
    // The If's two ways out are named where they leave it.
    expect(screen.getByText('yes')).toBeInTheDocument();
    expect(screen.getByText('no')).toBeInTheDocument();
  });

  // A newer build's node, in a flow the server kept. It is drawn by its type, and its wires still
  // have ports to meet: the ones they name, since this build knows no others for it.
  it('draws a node of a type it does not know by that type, meeting the wires it has', async () => {
    draw({
      ...button,
      nodes: [...button.nodes, { id: 'fn', type: 'function', x: 560, y: 80, config: { code: 'return msg;' } }],
      edges: [...button.edges, { id: 'e2', from: 'test', fromPort: 'yes', to: 'fn', toPort: 'in' }],
    });

    expect(await screen.findByText('function')).toBeInTheDocument();
    expect(screen.getByText('not known to this build')).toBeInTheDocument();
    expect(port('fn', 'in')).not.toBeNull();
    expect(document.querySelectorAll('.react-flow__handle[data-nodeid="fn"]')).toHaveLength(1);
    expect(screen.getByLabelText('Edge from test to fn')).toBeInTheDocument();
  });

  // The server's last word on a node — the value it read, or what went wrong — is the only place it
  // says why a count of errors went up.
  it('gives each node\'s status line the server\'s last word on it', async () => {
    useFlowStatusStore.getState().setStatus({
      flows: [{
        id: 'button', faults: 0, fault: null,
        nodes: [
          { id: 'go', count: 1, outs: {}, errors: 1, note: 'More than 50 publishes a second; this one was dropped.', standing: [] },
          { id: 'test', count: 5, outs: { yes: 2, no: 3 }, errors: 0, note: 'no such field', standing: [] },
        ],
      }],
    });

    draw();

    expect(await screen.findByText('1 sent · 1 error')).toHaveAttribute('title', 'More than 50 publishes a second; this one was dropped.');
    expect(screen.getByText('yes 2 · no 3')).toHaveAttribute('title', 'no such field');
  });

  it('says a node is not deployed when the flow is not running', async () => {
    draw(button, false);

    expect(await screen.findAllByText('not deployed')).toHaveLength(2);
  });

  // A running flow reports every node of the version it runs, so a node it does not report is one
  // that is only in the draft. "Waiting" would say it is running and has had nothing yet.
  it('says a node the running flow does not report is not deployed', async () => {
    useFlowStatusStore.getState().setStatus({
      flows: [{ id: 'button', faults: 0, fault: null, nodes: [{ id: 'go', count: 3, outs: { out: 3 }, errors: 0, note: null, standing: [] }] }],
    });

    draw();

    expect(await screen.findByText('3 sent')).toBeInTheDocument();
    expect(screen.getByText('not deployed')).toBeInTheDocument();
    expect(screen.queryByText('waiting')).toBeNull();
  });

  it('marks a node and a wire the server said are wrong, the node with its reason', async () => {
    draw(button, true, { 'node:test': ['Pick a test.'], 'edge:e1': ['Not this wire.'] });

    const refused = await screen.findByTitle('Pick a test.');
    expect(refused).toHaveAttribute('data-problem');
    expect(screen.getByLabelText('Edge from go to test').querySelector('.react-flow__edge-path')).toHaveAttribute('data-problem');
    expect(screen.getByText('Inject').closest('[data-group]')).not.toHaveAttribute('data-problem');
  });

  it('presses a running Inject node on the server', async () => {
    let pressed = '';
    server.use(
      http.post('/api/flows/:flow/nodes/:node/inject', ({ params }) => {
        pressed = `${params.flow}/${params.node}`;
        return new HttpResponse(null, { status: 202 });
      }),
    );
    useFlowStatusStore.getState().setStatus({
      flows: [{ id: 'button', faults: 0, fault: null, nodes: [{ id: 'go', count: 0, outs: {}, errors: 0, note: null, standing: [] }] }],
    });

    draw();
    fireEvent.click(await screen.findByRole('button', { name: 'Inject' }));

    await vi.waitFor(() => expect(pressed).toBe('button/go'));
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
    expect(draft.nodes.map((node) => node.type)).toEqual(['inject', 'if', 'debug']);
    expect(useFlowDraftStore.getState().selected).toBe(draft.nodes[2].id);
  });

  it('lights a wire when the node it leaves sends something down it', async () => {
    const status = (sent: number) => ({
      flows: [{ id: 'button', faults: 0, fault: null, nodes: [{ id: 'go', count: sent, outs: { out: sent }, errors: 0, note: null, standing: [] }] }],
    });
    useFlowStatusStore.getState().setStatus(status(1));
    draw();
    await screen.findByText('If');

    act(() => useFlowStatusStore.getState().setStatus(status(2)));

    expect(document.querySelector('[data-flash]')).not.toBeNull();
    expect(useFlowStatusStore.getState().nodes[nodeKey('button', 'go')].outs.out).toBe(2);
  });

  // Pushes come four times a second, each with a new object for every node, and a flow can hold
  // two hundred nodes. A node draws again only when what it shows of its numbers has moved.
  it('draws a node again only when what it shows of its numbers moved', async () => {
    const status = (sent: number): FlowStatusDto => ({
      flows: [{
        id: 'button', faults: 0, fault: null,
        nodes: [
          { id: 'go', count: sent, outs: { out: sent }, errors: 0, note: null, standing: [] },
          { id: 'test', count: 5, outs: { yes: 2, no: 3 }, errors: 0, note: null, standing: [] },
        ],
      }],
    });
    useFlowStatusStore.getState().setStatus(status(3));
    const inject = vi.spyOn(NODE_SPECS.inject, 'summary');
    const branch = vi.spyOn(NODE_SPECS.if, 'summary');
    draw();
    await screen.findByText('3 sent');
    inject.mockClear();
    branch.mockClear();

    act(() => useFlowStatusStore.getState().setStatus(status(3)));
    const again = { inject: inject.mock.calls.length, branch: branch.mock.calls.length };

    act(() => useFlowStatusStore.getState().setStatus(status(4)));
    const moved = { inject: inject.mock.calls.length, branch: branch.mock.calls.length };
    inject.mockRestore();
    branch.mockRestore();

    expect(again).toEqual({ inject: 0, branch: 0 });
    expect(screen.getByText('4 sent')).toBeInTheDocument();
    expect(moved).toEqual({ inject: 1, branch: 0 });
  });

  it('does not light a wire when its count starts again from nothing', async () => {
    const status = (sent: number) => ({
      flows: [{ id: 'button', faults: 0, fault: null, nodes: [{ id: 'go', count: sent, outs: { out: sent }, errors: 0, note: null, standing: [] }] }],
    });
    useFlowStatusStore.getState().setStatus(status(5));
    draw();
    await screen.findByText('If');

    // A deploy restarts the flow and its numbers with it, and a stopped flow has none at all.
    // Neither is a message going down the wire.
    act(() => useFlowStatusStore.getState().setStatus(status(0)));
    expect(document.querySelector('[data-flash]')).toBeNull();

    act(() => useFlowStatusStore.getState().setStatus(status(3)));
    act(() => useFlowStatusStore.getState().setStatus({ flows: [] }));
    await waitFor(() => expect(document.querySelector('[data-flash]')).toBeNull());
  });

  it('lights the wire of the port a message left by, and no other', async () => {
    const branches: FlowDto = {
      ...button,
      nodes: [
        ...button.nodes,
        { id: 'hot', type: 'debug', x: 560, y: 40, config: {} },
        { id: 'cold', type: 'debug', x: 560, y: 160, config: {} },
      ],
      edges: [
        ...button.edges,
        { id: 'e2', from: 'test', fromPort: 'yes', to: 'hot', toPort: 'in' },
        { id: 'e3', from: 'test', fromPort: 'no', to: 'cold', toPort: 'in' },
      ],
    };
    const status = (yes: number, no: number, count = yes + no) => ({
      flows: [{ id: 'button', faults: 0, fault: null, nodes: [{ id: 'test', count, outs: { yes, no }, errors: 0, note: null, standing: [] }] }],
    });
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
    const rules = sheet.replace(/\/\*[\s\S]*?\*\//g, '');
    const at = (mark: string) => rules.indexOf(`.wire[data-${mark}]`);

    expect(at('selected')).toBeGreaterThan(-1);
    expect(at('flash')).toBeGreaterThan(at('selected'));
    expect(at('problem')).toBeGreaterThan(at('flash'));
  });

  // A wire that was clicked has the focus as well as the pick, and React Flow draws a focused wire
  // in its own selected colour by a rule that outweighs the marks above. It reads that colour from
  // a variable, so a lit wire and a refused one say their colour there too.
  it('keeps a clicked wire lit, and a refused one red', () => {
    const rules = sheet.replace(/\/\*[\s\S]*?\*\//g, '');
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
    const wire = () => screen.getByLabelText('Edge from go to test');
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
    draw({ ...button, edges: [{ ...button.edges[0], id: 'go' }] });
    await screen.findByText('If');

    fireEvent.click(screen.getByLabelText('Edge from go to test'));

    expect(screen.getByLabelText('Edge from go to test').querySelector('.react-flow__edge-path')).toHaveAttribute('data-selected');
    expect(screen.getByText('Inject').closest('[data-group]')).not.toHaveAttribute('data-selected');
  });

  // The keys go where the reader's click put the keyboard: on the wire or the node that was clicked.
  it('takes a picked wire out of the draft when Delete is pressed', async () => {
    draw();
    await screen.findByText('If');
    const wire = screen.getByLabelText('Edge from go to test');

    fireEvent.click(wire);
    fireEvent.keyDown(wire, { key: 'Delete' });
    fireEvent.keyUp(wire, { key: 'Delete' });

    await waitFor(() => expect(useFlowDraftStore.getState().drafts.button?.edges).toEqual([]));
    expect(useFlowDraftStore.getState().drafts.button.nodes.map((node) => node.id)).toEqual(['go', 'test']);
  });

  it('takes a picked node out of the draft with its wires, and the inspector lets it go', async () => {
    draw();
    const picked = await screen.findByText('If');

    fireEvent.click(picked);
    expect(useFlowDraftStore.getState().selected).toBe('test');
    fireEvent.keyDown(picked, { key: 'Backspace' });
    fireEvent.keyUp(picked, { key: 'Backspace' });

    await waitFor(() => expect(useFlowDraftStore.getState().drafts.button?.nodes.map((node) => node.id)).toEqual(['go']));
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
    await waitFor(() => expect(useFlowDraftStore.getState().drafts.button?.nodes.map((node) => node.id)).toEqual(['go']));

    act(() => useFlowDraftStore.getState().discard('button'));
    expect((await screen.findByText('If')).closest('[data-group]')).not.toHaveAttribute('data-selected');

    // Still in the canvas, where a Backspace would take whatever was picked.
    const canvas = document.getElementById('flow-canvas')!;
    fireEvent.keyDown(canvas, { key: 'Backspace' });
    fireEvent.keyUp(canvas, { key: 'Backspace' });
    // React Flow deletes a turn later, so give it the turn before saying it took nothing.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(useFlowDraftStore.getState().drafts.button).toBeUndefined();
  });

  // Discard also clears the inspector. The canvas has to agree, or it frames a node the inspector
  // is not showing.
  it('lets go of a picked node when its draft is discarded', async () => {
    drawPage();
    const inject = (await screen.findByText('Inject')).closest<HTMLElement>('.react-flow__node')!;

    fireEvent.click(inject);
    fireEvent.keyDown(inject, { key: 'ArrowRight' });
    expect(useFlowDraftStore.getState().drafts.button).toBeDefined();

    act(() => useFlowDraftStore.getState().discard('button'));

    expect(useFlowDraftStore.getState().selected).toBeNull();
    expect(screen.getByText('Inject').closest('[data-group]')).not.toHaveAttribute('data-selected');
    expect(inject.style.transform).toBe('translate(40px,80px)');
  });

  // Something besides the Delete key can take one of several picked nodes away through React Flow:
  // the inspector deleting the node it shows, say. It then shows a node still picked, and the
  // canvas keeps that one framed.
  it('shows another picked node when the one on show is deleted', async () => {
    render(
      <ReactFlowProvider>
        <div style={{ width: 800, height: 600 }}>
          <Page flow={button} />
        </div>
        <DeleteNode id="test" />
      </ReactFlowProvider>,
    );
    // React Flow picks more than one with Meta on a Mac and with Control anywhere else.
    const more = navigator.userAgent.includes('Mac') ? 'Meta' : 'Control';

    fireEvent.click(await screen.findByText('Inject'));
    fireEvent.keyDown(window, { key: more });
    fireEvent.click(screen.getByText('If'));
    fireEvent.keyUp(window, { key: more });
    expect(useFlowDraftStore.getState().selected).toBe('test');

    fireEvent.click(screen.getByRole('button', { name: 'Delete test' }));

    await waitFor(() => expect(useFlowDraftStore.getState().selected).toBe('go'));
    expect(screen.getByText('Inject').closest('[data-group]')).toHaveAttribute('data-selected');
  });

  it('lets go of a picked wire that leaves the flow some other way', async () => {
    drawPage();
    await screen.findByText('If');

    fireEvent.click(screen.getByLabelText('Edge from go to test'));
    // Not through React Flow: the flow simply stops having the wire, and then has it again.
    act(() => useFlowDraftStore.getState().edit(button, (flow) => removeEdges(flow, ['e1'])));
    act(() => useFlowDraftStore.getState().discard('button'));

    const wire = screen.getByLabelText('Edge from go to test').querySelector('.react-flow__edge-path')!;
    expect(wire).not.toHaveAttribute('data-selected');
  });

  // Clicking one port and then another is React Flow's other way of drawing a wire, and it asks
  // the same question a dragged wire does before it lands.
  it('draws a wire from one port to another, and refuses one the server would refuse', async () => {
    draw({ ...button, nodes: [...button.nodes, { id: 'print', type: 'debug', x: 560, y: 80, config: {} }] });
    await screen.findByText('Debug');

    // The wire from go to test is already there, and a second one is refused.
    fireEvent.click(port('go', 'out'));
    fireEvent.click(port('test', 'in'));
    expect(useFlowDraftStore.getState().drafts.button).toBeUndefined();

    fireEvent.click(port('test', 'yes'));
    fireEvent.click(port('print', 'in'));
    expect(useFlowDraftStore.getState().drafts.button.edges).toEqual([
      button.edges[0],
      { id: expect.any(String), from: 'test', fromPort: 'yes', to: 'print', toPort: 'in' },
    ]);
  });

  // A mouse drag moves a node with the same change the arrow keys make. The drag itself cannot be
  // driven here: jsdom lays nothing out, so the canvas is zero pixels wide to React Flow's pan-at-
  // the-edge, which then pans on every drag and moves the node by however long the test took.
  it('moves a picked node with the arrow keys, and draws it where the draft now has it', async () => {
    drawPage();
    const node = (await screen.findByText('Inject')).closest<HTMLElement>('.react-flow__node')!;

    fireEvent.click(node);
    fireEvent.keyDown(node, { key: 'ArrowRight' });

    expect(useFlowDraftStore.getState().drafts.button.nodes[0]).toMatchObject({ id: 'go', x: 48, y: 80 });
    expect(node.style.transform).toBe('translate(48px,80px)');
  });

  it('puts a dropped node where the pointer let it go', async () => {
    draw();
    await screen.findByText('If');

    const dataTransfer = { types: [DRAG_TYPE], getData: () => 'debug', dropEffect: 'none' };
    fireEvent.drop(document.getElementById('flow-canvas')!, { dataTransfer, clientX: 200, clientY: 120 });

    // Where the new node's corner is drawn: its place on the canvas, through the canvas's pan and
    // zoom. That is the drop point, to the nearest step of the 8-pixel grid.
    const { x, y } = useFlowDraftStore.getState().drafts.button.nodes[2];
    const [panX, panY, zoom] = viewport();
    expect(Math.abs(panX + x * zoom - 200)).toBeLessThanOrEqual(4 * zoom);
    expect(Math.abs(panY + y * zoom - 120)).toBeLessThanOrEqual(4 * zoom);
  });

  // The Inject button's own click stops there and never picks the node it sits in, so a Backspace
  // pressed on it is not about that node. Left to the canvas, it would instead take away whatever
  // else is picked, quite possibly a node panned out of sight a while ago.
  it('leaves a node picked elsewhere alone when Backspace is pressed on the Inject button', async () => {
    useFlowStatusStore.getState().setStatus({
      flows: [{ id: 'button', faults: 0, fault: null, nodes: [{ id: 'go', count: 0, outs: {}, errors: 0, note: null, standing: [] }] }],
    });
    draw();
    const picked = await screen.findByText('If');

    fireEvent.click(picked);
    expect(useFlowDraftStore.getState().selected).toBe('test');

    const inject = screen.getByRole('button', { name: 'Inject' });
    act(() => inject.focus());
    fireEvent.keyDown(inject, { key: 'Backspace' });
    fireEvent.keyUp(inject, { key: 'Backspace' });
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));

    // Nothing was touched at all: the button never picks its own node, so a draft that dropped
    // "test" and kept "go" would be just as wrong as one that lost both.
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
