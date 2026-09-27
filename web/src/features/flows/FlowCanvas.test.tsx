import { ReactFlowProvider } from '@xyflow/react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { nodeKey, useFlowStatusStore } from '../../stores/flowStatusStore';
import { server } from '../../test/server';
import { renderWithClient as render } from '../../test/renderWithClient';
import type { FlowDto } from '../../types/api';
import { standInForTheBrowser } from './canvasTestbed';
import { DRAG_TYPE, FlowCanvas } from './FlowCanvas';
import { useFlowDraftStore } from './flowDraftStore';

beforeAll(() => standInForTheBrowser());
afterAll(() => vi.unstubAllGlobals());

beforeEach(() => {
  localStorage.clear();
  useFlowDraftStore.setState({ drafts: {}, current: null, selected: null, refusals: {} });
  useFlowStatusStore.setState({ flows: {}, nodes: {}, debug: [], debugDropped: 0 });
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

const draw = (flow: FlowDto = button, running = true) =>
  render(
    <ReactFlowProvider>
      <div style={{ width: 800, height: 600 }}>
        <FlowCanvas flow={flow} running={running} />
      </div>
    </ReactFlowProvider>,
  );

/** The canvas as the page draws it: the flow's draft once it has one, the deployed flow until then. */
function Page({ flow }: { flow: FlowDto }) {
  const draft = useFlowDraftStore((state) => state.drafts[flow.id]);
  return <FlowCanvas flow={draft ?? flow} running />;
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

  it('says a node is not deployed when the flow is not running', async () => {
    draw(button, false);

    expect(await screen.findAllByText('not deployed')).toHaveLength(2);
  });

  it('marks a node the server refused, with its reason', async () => {
    useFlowDraftStore.getState().refuse('button', { 'node:test': ['Pick a test.'] });

    draw();

    const refused = await screen.findByTitle('Pick a test.');
    expect(refused).toHaveAttribute('data-problem');
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

  it('takes a picked wire out of the draft when Delete is pressed', async () => {
    draw();
    await screen.findByText('If');

    fireEvent.click(screen.getByLabelText('Edge from go to test'));
    fireEvent.keyDown(document, { key: 'Delete' });
    fireEvent.keyUp(document, { key: 'Delete' });

    await waitFor(() => expect(useFlowDraftStore.getState().drafts.button?.edges).toEqual([]));
    expect(useFlowDraftStore.getState().drafts.button.nodes.map((node) => node.id)).toEqual(['go', 'test']);
  });

  it('takes a picked node out of the draft with its wires, and the inspector lets it go', async () => {
    draw();

    fireEvent.click(await screen.findByText('If'));
    expect(useFlowDraftStore.getState().selected).toBe('test');
    fireEvent.keyDown(document, { key: 'Backspace' });
    fireEvent.keyUp(document, { key: 'Backspace' });

    await waitFor(() => expect(useFlowDraftStore.getState().drafts.button?.nodes.map((node) => node.id)).toEqual(['go']));
    expect(useFlowDraftStore.getState().drafts.button.edges).toEqual([]);
    expect(useFlowDraftStore.getState().selected).toBeNull();
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
    render(
      <ReactFlowProvider>
        <div style={{ width: 800, height: 600 }}>
          <Page flow={button} />
        </div>
      </ReactFlowProvider>,
    );
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
});
