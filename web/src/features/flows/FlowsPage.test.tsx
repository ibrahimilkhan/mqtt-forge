import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '../../api/queryKeys';
import { useFlowStatusStore } from '../../stores/flowStatusStore';
import { server } from '../../test/server';
import { renderWithClient as render } from '../../test/renderWithClient';
import type { FlowDebugDto, FlowDto, FlowNodeDto, FlowsDto, FlowStatusDto } from '../../types/api';
import { standInForTheBrowser } from './canvasTestbed';
import { NODE_HEIGHT, NODE_WIDTH } from './FlowCanvas';
import { useFlowDraftStore } from './flowDraftStore';
import FlowsPage from './FlowsPage';

beforeAll(() => standInForTheBrowser());
afterAll(() => vi.unstubAllGlobals());

beforeEach(() => {
  localStorage.clear();
  useFlowDraftStore.setState({ drafts: {}, current: null, selected: null, refusals: {} });
  useFlowStatusStore.setState(useFlowStatusStore.getInitialState());
});

const watch: FlowDto = {
  id: 'watch',
  name: 'Boiler watch',
  enabled: true,
  nodes: [
    { id: 'in', type: 'mqttIn', x: 40, y: 120, config: { filter: 'plant/+/temp', replay: false } },
    { id: 'test', type: 'if', x: 300, y: 120, config: { field: '$.temp', test: 'gt', value: '90', value2: '' } },
  ],
  edges: [{ id: 'e1', from: 'in', fromPort: 'out', to: 'test', toPort: 'in' }],
};

const sim: FlowDto = {
  id: 'sim',
  name: 'Boiler simulator',
  enabled: true,
  nodes: [{ id: 'tick', type: 'every', x: 40, y: 100, config: { seconds: 2, topic: '', payload: '["k1","k2","k3"]' } }],
  edges: [],
};

/** What the server says the watch has done, with this many messages in. */
const watchHasSeen = (count: number): FlowStatusDto => ({
  flows: [{
    id: 'watch', faults: 0, fault: null,
    nodes: [{ id: 'in', count, outs: { out: count }, errors: 0, note: null, standing: [] }],
  }],
});

/** A promise the test lets go of when it chooses, for an answer that has to arrive late. */
function held() {
  let release = () => {};
  const until = new Promise<void>((resolve) => (release = resolve));
  return { until, release };
}

/** A few turns of the clock: long enough for an answer the server has sent to reach the page. */
async function turns(count = 5) {
  for (let turn = 0; turn < count; turn++) await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
}

/** The answer the server gives a deploy it refuses. */
const refusal = (errors: Record<string, string[]>) =>
  HttpResponse.json(
    { title: 'The flow was not deployed', detail: Object.values(errors)[0][0], reason: 'flowInvalid', errors },
    { status: 400, headers: { 'Content-Type': 'application/problem+json' } },
  );

/** A server that keeps what it is sent, the way the real one does. */
function keeping(initial: FlowDto[] = [], over: Partial<FlowsDto> = {}) {
  const kept = [...initial];
  const puts: FlowDto[] = [];

  server.use(
    http.get('/api/flows', () =>
      HttpResponse.json({ flows: kept, problems: [], unreadable: false, allowWebhooks: true, alertTopicPrefix: 'mqttforge/alerts/', ...over }),
    ),
    http.put('/api/flows/:id', async ({ request }) => {
      const flow = (await request.json()) as FlowDto;
      puts.push(flow);
      const at = kept.findIndex((one) => one.id === flow.id);
      if (at >= 0) kept[at] = flow;
      else kept.push(flow);
      return HttpResponse.json({ flow });
    }),
  );

  return { kept, puts };
}

describe('Flows page', () => {
  it('offers an example and an empty flow when there are no flows', async () => {
    keeping();
    render(<FlowsPage />);

    expect(await screen.findByRole('button', { name: 'Start from an example' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New flow' })).toBeInTheDocument();
  });

  it('makes the two example flows as drafts, ready to deploy', async () => {
    keeping();
    render(<FlowsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Start from an example' }));

    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      expect.stringContaining('Boiler simulator'),
      expect.stringContaining('Boiler watch'),
    ]);
    expect(screen.getByText('2 changes')).toBeInTheDocument();
    expect(await screen.findByText('every 2 s')).toBeInTheDocument();
  });

  it('deploys every changed flow, one request each, and then has nothing left to deploy', async () => {
    const server = keeping();
    render(<FlowsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Start from an example' }));
    await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));

    await waitFor(() => expect(server.puts.map((flow) => flow.name)).toEqual(['Boiler simulator', 'Boiler watch']));
    expect(await screen.findByText('All deployed')).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(2);
  });

  it('marks what the server refused and keeps the draft', async () => {
    keeping([watch]);
    server.use(
      http.put('/api/flows/watch', () =>
        HttpResponse.json(
          { title: 'The flow was not deployed', detail: 'Pick a test.', reason: 'flowInvalid', errors: { 'node:test': ['Pick a test.'] } },
          { status: 400, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    );
    render(<FlowsPage />);

    await userEvent.click(await screen.findByRole('checkbox', { name: 'Run it once deployed' }));
    await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));

    expect(await screen.findByTitle('Pick a test.')).toHaveAttribute('data-problem');
    expect(screen.getByText('1 change')).toBeInTheDocument();
  });

  it('puts a flow back to what is running on Discard', async () => {
    keeping([watch]);
    render(<FlowsPage />);

    const name = await screen.findByLabelText('Name');
    await userEvent.type(name, ' 2');
    expect(screen.getByRole('tab', { name: /Boiler watch 2/ })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));

    expect(screen.getByRole('tab', { name: /^Boiler watch/ })).toBeInTheDocument();
    expect(screen.getByText('All deployed')).toBeInTheDocument();
  });

  it('adds a node from the palette, picked and ready to set up', async () => {
    keeping([watch]);
    render(<FlowsPage />);

    await userEvent.click(within(await screen.findByRole('navigation', { name: 'Nodes' })).getByRole('button', { name: /Publish/ }));

    expect(screen.getByRole('heading', { name: 'Publish' })).toBeInTheDocument();
    expect(screen.getByText('1 change')).toBeInTheDocument();
  });

  // Three clicks are three nodes that can each be read and grabbed. Stepped a few pixels from the
  // last, each new node covered the title of the one before and hid its ports under its own.
  it('puts each node the palette adds where it covers no other', async () => {
    keeping();
    render(<FlowsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'New flow' }));
    const palette = within(screen.getByRole('navigation', { name: 'Nodes' }));

    for (const name of [/^Inject/, /^Debug/, /^Publish/]) await userEvent.click(palette.getByRole('button', { name }));

    const [flow] = Object.values(useFlowDraftStore.getState().drafts);
    const apart = (a: FlowNodeDto, b: FlowNodeDto) =>
      a.x + NODE_WIDTH <= b.x || b.x + NODE_WIDTH <= a.x || a.y + NODE_HEIGHT <= b.y || b.y + NODE_HEIGHT <= a.y;
    expect(flow.nodes.map((node) => node.type)).toEqual(['inject', 'debug', 'publish']);
    for (const [i, a] of flow.nodes.entries())
      for (const b of flow.nodes.slice(i + 1)) expect(apart(a, b), `${a.type} and ${b.type} overlap`).toBe(true);
  });

  it('shows what the running flow has done under each node', async () => {
    keeping([watch]);
    server.use(
      http.get('/api/flows/status', () =>
        HttpResponse.json({
          flows: [{
            id: 'watch', faults: 0, fault: null,
            nodes: [
              { id: 'in', count: 412, outs: { out: 412 }, errors: 0, note: null, standing: [] },
              { id: 'test', count: 412, outs: { yes: 3, no: 409 }, errors: 0, note: null, standing: [] },
            ],
          }],
        }),
      ),
    );
    render(<FlowsPage />);

    expect(await screen.findByText('412 in')).toBeInTheDocument();
    expect(screen.getByText('yes 3 · no 409')).toBeInTheDocument();
    expect(screen.getByText('Running.')).toBeInTheDocument();
  });

  it('prints the debug lines of the flow on screen', async () => {
    keeping([watch]);
    render(<FlowsPage />);
    await screen.findByText('Boiler watch', { selector: 'h3' });

    useFlowStatusStore.getState().addDebug(
      [{ flowId: 'watch', nodeId: 'in', at: '2026-09-26T09:14:22Z', kind: 'message', topic: 'plant/k1/temp', text: '{"temp":94.2}' }],
      0,
    );

    expect(await screen.findByText('{"temp":94.2}')).toBeInTheDocument();
  });

  it('says a flows file the server cannot read, and draws nothing over it', async () => {
    keeping([], { unreadable: true });
    render(<FlowsPage />);

    expect(await screen.findByText(/could not be read/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Deploy' })).not.toBeInTheDocument();
  });

  it('makes a new flow from beside the tabs, and shows it', async () => {
    keeping([watch]);
    render(<FlowsPage />);
    await screen.findByRole('tab', { name: /Boiler watch/ });

    await userEvent.click(screen.getByRole('button', { name: 'New flow' }));

    expect(screen.getByRole('tab', { name: /Flow 1/, selected: true })).toBeInTheDocument();
    expect(screen.getByText('1 change')).toBeInTheDocument();
    // A tab list owns tabs and nothing else, so the button that adds one stands beside it.
    expect(within(screen.getByRole('tablist')).queryAllByRole('button')).toEqual([]);
  });

  // Back to what is running means nothing for a flow that has never run. Throwing the whole flow
  // away is what Delete flow does, and that asks first.
  it('offers no Discard for a flow that was never deployed', async () => {
    keeping();
    render(<FlowsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Start from an example' }));

    expect(screen.getByText('2 changes')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Discard' })).not.toBeInTheDocument();
  });

  // What was typed while the request was out is newer than what went, and was never deployed.
  it('keeps what was typed while a deploy was on its way', async () => {
    const { kept } = keeping([watch]);
    let answer = () => {};
    const held = new Promise<void>((resolve) => (answer = resolve));
    server.use(
      http.put('/api/flows/:id', async ({ request }) => {
        const flow = (await request.json()) as FlowDto;
        await held;
        kept[0] = flow;
        return HttpResponse.json({ flow });
      }),
    );
    render(<FlowsPage />);

    const name = await screen.findByLabelText('Name');
    await userEvent.type(name, ' 2');
    await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));
    await screen.findByRole('button', { name: 'Deploying…' });

    await userEvent.type(name, 'b');
    answer();

    await screen.findByRole('button', { name: 'Deploy' });
    expect(kept[0].name).toBe('Boiler watch 2');
    expect(screen.getByRole('tab', { name: /Boiler watch 2b/ })).toBeInTheDocument();
    expect(screen.getByText('1 change')).toBeInTheDocument();
  });

  // The page covers the log, so a deploy that did not go through says why where it was pressed.
  it('says why a deploy did not go through', async () => {
    keeping([watch]);
    server.use(
      http.put('/api/flows/watch', () =>
        HttpResponse.json(
          { title: 'Could not save the flows', detail: 'The disk is full.', reason: 'flowsNotSaved' },
          { status: 500, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    );
    render(<FlowsPage />);

    await userEvent.click(await screen.findByRole('checkbox', { name: 'Run it once deployed' }));
    await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));

    expect(await screen.findByText('Not deployed. The disk is full.')).toBeInTheDocument();
    expect(screen.getByText('1 change')).toBeInTheDocument();
  });

  it('says when the flows cannot be read at all', async () => {
    server.use(http.get('/api/flows', () => HttpResponse.json({ title: 'Server error' }, { status: 500 })));
    render(<FlowsPage />);

    expect(await screen.findByText(/The flows could not be read from the server/)).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });

  // A read that fails once the flows are on screen takes nothing away: the drafts are all still
  // here, and a deploy says for itself when the server is not there.
  it('keeps the flows on screen when a later read fails', async () => {
    keeping([watch]);
    const { queryClient } = render(<FlowsPage />);
    await screen.findByRole('tab', { name: /Boiler watch/ });

    server.use(http.get('/api/flows', () => HttpResponse.json({ title: 'Server error' }, { status: 500 })));
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.flows }));
    // The query tells the page on the next turn of the clock, not in the one the read failed in.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));

    expect(queryClient.getQueryState(queryKeys.flows)?.status).toBe('error');
    expect(screen.getByRole('tab', { name: /Boiler watch/ })).toBeInTheDocument();
    expect(screen.queryByText(/could not be read/)).not.toBeInTheDocument();
  });

  it('clears the debug lines', async () => {
    keeping([watch]);
    render(<FlowsPage />);
    await screen.findByText('Boiler watch', { selector: 'h3' });
    act(() =>
      useFlowStatusStore.getState().addDebug(
        [{ flowId: 'watch', nodeId: 'in', at: '2026-09-26T09:14:22Z', kind: 'message', topic: 'plant/k1/temp', text: '{"temp":94.2}' }],
        0,
      ),
    );

    const clear = within(screen.getByRole('region', { name: 'Debug' })).getByRole('button', { name: 'Clear' });
    // Something goes when it is pressed, so it wears the tone every other Clear in the console does.
    expect(clear).toHaveClass('ends');
    await userEvent.click(clear);

    expect(screen.queryByText('{"temp":94.2}')).not.toBeInTheDocument();
    expect(screen.getByText(/Nothing yet/)).toBeInTheDocument();
  });

  it('folds the debug strip to its header, and remembers it', async () => {
    keeping([watch]);
    const { unmount } = render(<FlowsPage />);
    const fold = () => within(screen.getByRole('region', { name: 'Debug' })).getByRole('button', { name: /Debug/ });

    await screen.findByText(/Nothing yet/);
    await userEvent.click(fold());
    expect(fold()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/Nothing yet/)).not.toBeInTheDocument();
    unmount();

    render(<FlowsPage />);
    await screen.findByRole('region', { name: 'Debug' });
    expect(fold()).toHaveAttribute('aria-expanded', 'false');
  });
});

/** The tab of the flow on screen. */
const shownTab = () => screen.getByRole('tab', { selected: true });

/**
 * Where the keyboard goes when the control it was on goes away.
 *
 * A browser hands the focus to the body when the focused button is taken out, or stops being one
 * that can be pressed, and the next Tab starts again from the top of the document. The reader
 * belongs on the tab of the flow they were working on — the same rule focusReturn.test.tsx holds
 * the panels to.
 */
describe('where the keyboard goes', () => {
  it('goes to the tab when Discard takes itself away', async () => {
    keeping([watch]);
    render(<FlowsPage />);
    await userEvent.type(await screen.findByLabelText('Name'), ' 2');

    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));

    expect(screen.queryByRole('button', { name: 'Discard' })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(shownTab());
  });

  it('goes to the tab when a deploy leaves nothing to deploy', async () => {
    keeping([watch]);
    render(<FlowsPage />);
    await userEvent.type(await screen.findByLabelText('Name'), ' 2');

    await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));

    expect(await screen.findByText('All deployed')).toBeInTheDocument();
    expect(document.activeElement).toBe(shownTab());
  });

  // A button that is switched off while it has the focus loses it in some browsers, so while the
  // run is out Deploy only says it is off, and answers no press. A refusal leaves it on again, with
  // the reader still on it.
  it('stays on Deploy while the run is out, and after a refusal', async () => {
    const { puts } = keeping([watch]);
    const answer = held();
    server.use(
      http.put('/api/flows/watch', async ({ request }) => {
        puts.push((await request.json()) as FlowDto);
        await answer.until;
        return refusal({ 'node:test': ['Pick a test.'] });
      }),
    );
    render(<FlowsPage />);
    await userEvent.type(await screen.findByLabelText('Name'), ' 2');

    await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));
    const running = await screen.findByRole('button', { name: 'Deploying…' });
    expect(running).toBeEnabled();
    expect(running).toHaveAttribute('aria-disabled', 'true');
    expect(document.activeElement).toBe(running);
    await userEvent.click(running);

    answer.release();
    expect(await screen.findByTitle('Pick a test.')).toBeInTheDocument();
    expect(document.activeElement).toBe(await screen.findByRole('button', { name: 'Deploy' }));
    expect(puts).toHaveLength(1);
  });

  it('goes to the first tab when the examples are made', async () => {
    keeping();
    render(<FlowsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Start from an example' }));

    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /^Boiler simulator/ }));
  });

  it('goes to the new tab when a first flow is made on the empty page', async () => {
    keeping();
    render(<FlowsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'New flow' }));

    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /^Flow 1/ }));
  });
});

/**
 * Backspace and Delete take away what is picked on the canvas, and only from the canvas. A node
 * stays picked while the reader goes on to a tab, to Deploy or to the palette, and a Backspace
 * pressed there is about that control: taking the node away would lose it out of sight.
 */
describe('the delete keys', () => {
  /** A node on the canvas, by the name its type is drawn with. The palette has one of each too. */
  const drawn = async (name: string) => {
    await screen.findByRole('tabpanel');
    return (await within(document.getElementById('flow-canvas')!).findByText(name)).closest<HTMLElement>('.react-flow__node')!;
  };

  it('take the picked node away while the keyboard is in the canvas', async () => {
    keeping([watch]);
    render(<FlowsPage />);
    const node = await drawn('If');

    // A click picks the node and gives it the keyboard; jsdom's click only does the first.
    fireEvent.click(node);
    act(() => node.focus());
    await userEvent.keyboard('{Backspace}');

    await waitFor(() => expect(useFlowDraftStore.getState().drafts.watch?.nodes.map((one) => one.id)).toEqual(['in']));
  });

  it('leave the picked node alone while the keyboard is on a tab, or on a button above the canvas', async () => {
    keeping([watch]);
    render(<FlowsPage />);
    // A change, so there is a Discard and a Deploy to be on.
    await userEvent.type(await screen.findByLabelText('Name'), ' 2');
    fireEvent.click(await drawn('If'));
    expect(useFlowDraftStore.getState().selected).toBe('test');

    for (const control of [shownTab(), screen.getByRole('button', { name: 'Discard' }), screen.getByRole('button', { name: 'Deploy' })]) {
      act(() => control.focus());
      await userEvent.keyboard('{Backspace}{Delete}');
      // React Flow deletes a turn after the key, so give it the turns before saying it took nothing.
      await turns();
    }

    expect(useFlowDraftStore.getState().drafts.watch.nodes.map((one) => one.id)).toEqual(['in', 'test']);
    expect(useFlowDraftStore.getState().selected).toBe('test');
  });
});

describe('the tabs', () => {
  // The lamp and the dot are drawn, and hidden from a screen reader, so the tab says in words what
  // they say. A flow that is running an older version of itself is not "not deployed": its edits are.
  it('say in their names whether each flow runs, and what of it is not deployed', async () => {
    keeping([watch]);
    server.use(http.get('/api/flows/status', () => HttpResponse.json(watchHasSeen(0))));
    render(<FlowsPage />);

    expect(await screen.findByRole('tab', { name: 'Boiler watch, running' })).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Name'), ' 2');
    expect(screen.getByRole('tab', { name: 'Boiler watch 2, running, changes not deployed' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'New flow' }));
    expect(screen.getByRole('tab', { name: 'Flow 1, not deployed' })).toBeInTheDocument();
  });

  it('say when a flow is not running, and when the server refused its changes', async () => {
    keeping([watch]);
    server.use(http.put('/api/flows/watch', () => refusal({ 'node:test': ['Pick a test.'] })));
    render(<FlowsPage />);

    expect(await screen.findByRole('tab', { name: 'Boiler watch, not running' })).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Name'), ' 2');
    await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));

    expect(await screen.findByRole('tab', { name: 'Boiler watch 2, refused, changes not deployed' })).toBeInTheDocument();
  });

  it('control one panel, which the tab on show names', async () => {
    keeping([watch, sim]);
    render(<FlowsPage />);
    await screen.findByText('Boiler watch', { selector: 'h3' });

    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAttribute('aria-labelledby', shownTab().id);
    expect(panel).toHaveAccessibleName(/^Boiler watch/);
    for (const tab of screen.getAllByRole('tab')) expect(tab).toHaveAttribute('aria-controls', panel.id);
    expect(within(panel).getByRole('navigation', { name: 'Nodes' })).toBeInTheDocument();
    expect(within(panel).getByRole('complementary', { name: 'Inspector' })).toBeInTheDocument();
    expect(within(panel).getByRole('region', { name: 'Debug' })).toBeInTheDocument();
  });

  // One stop on the Tab key for the whole list, and the arrows to go along it — the way every tab
  // list is used. Showing a flow is instant, so the flow goes on screen as its tab takes the focus.
  it('go along with the arrow keys, Home and End, and show the flow they land on', async () => {
    const fan: FlowDto = { id: 'fan', name: 'Fan', enabled: true, nodes: [], edges: [] };
    keeping([watch, sim, fan]);
    render(<FlowsPage />);
    await screen.findByText('Boiler watch', { selector: 'h3' });
    const tabs = () => screen.getAllByRole('tab');
    const onScreen = () => screen.getByRole('complementary', { name: 'Inspector' }).querySelector('h3')?.textContent;

    expect(tabs().map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
    act(() => tabs()[0].focus());

    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(tabs()[1]);
    expect(tabs()[1]).toHaveAttribute('aria-selected', 'true');
    expect(tabs().map((tab) => tab.tabIndex)).toEqual([-1, 0, -1]);
    expect(onScreen()).toBe('Boiler simulator');

    await userEvent.keyboard('{End}');
    expect(document.activeElement).toBe(tabs()[2]);
    expect(onScreen()).toBe('Fan');

    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(tabs()[0]);

    await userEvent.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(tabs()[2]);

    await userEvent.keyboard('{Home}');
    expect(document.activeElement).toBe(tabs()[0]);
    expect(onScreen()).toBe('Boiler watch');
  });

  // A browser that gives the keyboard to a tab hanging half off the end of the row leaves it
  // there, its name and its ring cut off at the row's edge. It only scrolls to one it cannot see
  // at all.
  it('bring the tab they land on wholly into the row', async () => {
    keeping([watch, sim]);
    render(<FlowsPage />);
    await screen.findByText('Boiler watch', { selector: 'h3' });
    const [first, second] = screen.getAllByRole('tab');
    second.scrollIntoView = vi.fn();

    act(() => first.focus());
    await userEvent.keyboard('{ArrowRight}');

    expect(second.scrollIntoView).toHaveBeenCalledWith({ inline: 'nearest', block: 'nearest' });
  });
});

/** A line a Debug node printed, in a flow. */
const printed = (flowId: string, text: string, over: Partial<FlowDebugDto> = {}): FlowDebugDto => ({
  flowId, nodeId: 'in', at: '2026-09-26T09:14:22Z', kind: 'message', topic: 'plant/k1/temp', text, ...over,
});

const debugStrip = () => screen.getByRole('region', { name: 'Debug' });

describe('the debug strip', () => {
  it('keeps each flow\'s lines, and clears only the flow on screen', async () => {
    keeping([watch, sim]);
    render(<FlowsPage />);
    await screen.findByText('Boiler watch', { selector: 'h3' });
    act(() => useFlowStatusStore.getState().addDebug([printed('watch', 'w1'), printed('sim', 's1')], 0));

    expect(await within(debugStrip()).findByText('w1')).toBeInTheDocument();
    await userEvent.click(within(debugStrip()).getByRole('button', { name: 'Clear' }));
    expect(within(debugStrip()).queryByText('w1')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: /^Boiler simulator/ }));
    expect(within(debugStrip()).getByText('s1')).toBeInTheDocument();
  });

  // The strip is "the last 200, for the flow on screen": a flow printing on every message must not
  // push the one being looked at out of it.
  it('keeps the lines of the flow on screen however busy another flow is', async () => {
    keeping([watch, sim]);
    render(<FlowsPage />);
    await screen.findByText('Boiler watch', { selector: 'h3' });

    act(() => useFlowStatusStore.getState().addDebug([printed('watch', 'w1')], 0));
    act(() => useFlowStatusStore.getState().addDebug(Array.from({ length: 200 }, (_, i) => printed('sim', `s${i}`)), 0));

    expect(within(debugStrip()).getByText('w1')).toBeInTheDocument();
  });

  // The server says how many lines it left out, never whose they were, so no strip can claim them.
  // Each strip counts them from when it was last cleared.
  it('says lines were left out, from any flow, until this strip is cleared', async () => {
    keeping([watch, sim]);
    render(<FlowsPage />);
    await screen.findByText('Boiler watch', { selector: 'h3' });

    act(() => useFlowStatusStore.getState().addDebug([printed('watch', 'w1')], 3));
    expect(within(debugStrip()).getByText('3 left out, from any flow')).toBeInTheDocument();

    await userEvent.click(within(debugStrip()).getByRole('button', { name: 'Clear' }));
    expect(within(debugStrip()).queryByText(/left out/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: /^Boiler simulator/ }));
    expect(within(debugStrip()).getByText('3 left out, from any flow')).toBeInTheDocument();
  });

  // A row that is drawn again as each batch arrives loses whatever the reader had selected in it,
  // which is how a payload is copied out of a live flow.
  it('keeps a line\'s row as newer lines arrive above it', async () => {
    keeping([watch]);
    render(<FlowsPage />);
    await screen.findByText('Boiler watch', { selector: 'h3' });

    act(() => useFlowStatusStore.getState().addDebug([printed('watch', 'w1')], 0));
    const row = within(debugStrip()).getByText('w1').closest('li');
    act(() => useFlowStatusStore.getState().addDebug([printed('watch', 'w2')], 0));

    expect(within(debugStrip()).getByText('w1').closest('li')).toBe(row);
  });

  // A message with nothing in it is still a message. A line that printed only the time and the
  // node would read as one that failed to draw.
  it('says when a message came with no topic and an empty payload', async () => {
    keeping([watch]);
    render(<FlowsPage />);
    await screen.findByText('Boiler watch', { selector: 'h3' });

    act(() =>
      useFlowStatusStore.getState().addDebug(
        [printed('watch', '', { topic: '' }), printed('watch', 'The flow stopped.', { kind: 'error', topic: '' })],
        0,
      ),
    );

    const empty = within(debugStrip()).getByText('empty payload').closest('li')!;
    expect(within(empty).getByText('no topic')).toBeInTheDocument();
    // What went wrong is not about a message, so an error with no topic has nothing missing.
    const error = within(debugStrip()).getByText('The flow stopped.').closest('li')!;
    expect(within(error).queryByText('no topic')).not.toBeInTheDocument();
  });
});

describe('the numbers the page reads when it opens', () => {
  // Pushes carry nothing to put them in order by. A first read that comes back after a push has
  // landed was answered before it, so it is the older of the two, and drawn over the push it
  // would show a stopped flow as running until something moved again.
  it('keeps a push that lands while the read is out, rather than the older answer', async () => {
    keeping([watch]);
    const answer = held();
    let answered = false;
    server.use(
      http.get('/api/flows/status', async () => {
        await answer.until;
        answered = true;
        return HttpResponse.json(watchHasSeen(412));
      }),
    );
    render(<FlowsPage />);
    await screen.findByRole('tab', { name: /Boiler watch/ });

    act(() => useFlowStatusStore.getState().setStatus(watchHasSeen(500)));
    expect(await screen.findByText('500 in')).toBeInTheDocument();

    answer.release();
    await waitFor(() => expect(answered).toBe(true));
    await turns();

    expect(screen.getByText('500 in')).toBeInTheDocument();
    expect(screen.queryByText('412 in')).not.toBeInTheDocument();
  });

  it('lets the read go when the page is shut before it comes back', async () => {
    keeping([watch]);
    const answer = held();
    let answered = false;
    server.use(
      http.get('/api/flows/status', async () => {
        await answer.until;
        answered = true;
        return HttpResponse.json(watchHasSeen(412));
      }),
    );
    const { unmount } = render(<FlowsPage />);
    await screen.findByRole('tab', { name: /Boiler watch/ });

    unmount();
    answer.release();
    await waitFor(() => expect(answered).toBe(true));
    await turns();

    expect(useFlowStatusStore.getState().flows).toEqual({});
  });
});

describe('deploying', () => {
  it('sends the next flow when one is refused, and lets that one go', async () => {
    const { puts } = keeping([watch, sim]);
    server.use(
      http.put('/api/flows/watch', async ({ request }) => {
        puts.push((await request.json()) as FlowDto);
        return refusal({ 'node:test': ['Pick a test.'] });
      }),
    );
    useFlowDraftStore.getState().put({ ...watch, name: 'Boiler watch 2' });
    useFlowDraftStore.getState().put({ ...sim, name: 'Boiler simulator 2' });
    render(<FlowsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Deploy' }));

    await waitFor(() => expect(puts.map((flow) => flow.name)).toEqual(['Boiler watch 2', 'Boiler simulator 2']));
    expect(await screen.findByText('1 change')).toBeInTheDocument();
    expect(useFlowDraftStore.getState().drafts.sim).toBeUndefined();
    expect(useFlowDraftStore.getState().drafts.watch.name).toBe('Boiler watch 2');
    expect(useFlowDraftStore.getState().refusals.watch).toEqual({ 'node:test': ['Pick a test.'] });
  });

  // A draft that says what is already running is no change, however it came to be there.
  it('sends only the flows that differ from what is running', async () => {
    const { puts } = keeping([watch, sim]);
    useFlowDraftStore.getState().put({ ...watch });
    useFlowDraftStore.getState().put({ ...sim, name: 'Boiler simulator 2' });
    render(<FlowsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Deploy' }));

    expect(await screen.findByText('All deployed')).toBeInTheDocument();
    expect(puts.map((flow) => flow.id)).toEqual(['sim']);
  });

  // A server that cannot write the file will not write the next one either, and a run that went
  // on would only say so once for every flow.
  it('stops at a failure that is not a refusal, and says why', async () => {
    const { puts } = keeping([watch, sim]);
    server.use(
      http.put('/api/flows/watch', async ({ request }) => {
        puts.push((await request.json()) as FlowDto);
        return HttpResponse.json(
          { title: 'Could not save the flows', detail: 'The disk is full.', reason: 'flowsNotSaved' },
          { status: 500, headers: { 'Content-Type': 'application/problem+json' } },
        );
      }),
    );
    useFlowDraftStore.getState().put({ ...watch, name: 'Boiler watch 2' });
    useFlowDraftStore.getState().put({ ...sim, name: 'Boiler simulator 2' });
    render(<FlowsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Deploy' }));

    expect(await screen.findByText('Not deployed. The disk is full.')).toBeInTheDocument();
    expect(puts.map((flow) => flow.id)).toEqual(['watch']);
    expect(screen.getByText('2 changes')).toBeInTheDocument();
  });

  // A read of the list that set off before a flow was deployed answers with the flow as it was.
  // Let in after the deploy has written the new one, it would put the old flow back under a tab
  // whose draft has already gone.
  it('does not let a read that was already out put back the flow a deploy replaced', async () => {
    const kept = [watch, sim];
    const watchPut = held();
    const simPut = held();
    let reading: ReturnType<typeof held> | null = null;
    let asked = false;
    server.use(
      http.get('/api/flows', async () => {
        const flows = kept.map((flow) => ({ ...flow }));
        const hold = reading;
        asked = hold !== null;
        if (hold) await hold.until;
        return HttpResponse.json({ flows, problems: [], unreadable: false, allowWebhooks: true, alertTopicPrefix: 'mqttforge/alerts/' });
      }),
      http.put('/api/flows/:id', async ({ params, request }) => {
        const flow = (await request.json()) as FlowDto;
        await (params.id === 'watch' ? watchPut : simPut).until;
        kept[kept.findIndex((one) => one.id === flow.id)] = flow;
        return HttpResponse.json({ flow });
      }),
    );
    useFlowDraftStore.getState().put({ ...watch, name: 'Boiler watch 2' });
    useFlowDraftStore.getState().put({ ...sim, name: 'Boiler simulator 2' });
    useFlowDraftStore.getState().show('watch');
    const { queryClient } = render(<FlowsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Deploy' }));
    // The window comes back into focus while the first flow is on its way, and the list is read.
    const read = held();
    reading = read;
    act(() => void queryClient.invalidateQueries({ queryKey: queryKeys.flows }));
    await waitFor(() => expect(asked).toBe(true));

    watchPut.release();
    await waitFor(() => expect(useFlowDraftStore.getState().drafts.watch).toBeUndefined());
    read.release();
    await waitFor(() => expect(queryClient.getQueryState(queryKeys.flows)?.fetchStatus).toBe('idle'));
    await turns();

    expect(queryClient.getQueryData<FlowsDto>(queryKeys.flows)?.flows[0].name).toBe('Boiler watch 2');
    expect(screen.getByRole('tab', { name: /Boiler watch 2/ })).toBeInTheDocument();

    reading = null;
    simPut.release();
    expect(await screen.findByText('All deployed')).toBeInTheDocument();
  });
});

describe('what the server says is wrong with a flow in its file', () => {
  // A flow written into the file by hand that does not compile. The server does not run it, and
  // the inspector says why; the canvas and the tab have to say it from the same answer, or the
  // flow looks clean everywhere but one pane.
  it('is marked on the canvas and on the tab, from the answer the inspector reads', async () => {
    keeping([watch], {
      problems: [
        { flowId: 'watch', key: 'flow', message: 'The flow is not right.' },
        { flowId: 'watch', key: 'node:test', message: 'Pick a test.' },
        { flowId: 'watch', key: 'edge:e1', message: 'Not this wire.' },
      ],
    });
    render(<FlowsPage />);

    expect(await screen.findByText('The flow is not right.')).toBeInTheDocument();
    expect(await screen.findByTitle('Pick a test.')).toHaveAttribute('data-problem');
    expect(screen.getByLabelText('Edge from in to test').querySelector('[data-problem]')).not.toBeNull();
    expect(screen.getByRole('tab', { name: /Boiler watch/ })).toHaveAttribute('data-state', 'refused');
  });
});

describe('a refusal', () => {
  // A refusal is about a draft. Edited back to what is running, the flow has no draft for it to be
  // about: nothing may go on saying the server refused it beside "All deployed", and the next edit
  // must not bring it back.
  it('lapses once the flow is back to what is running', async () => {
    keeping([watch]);
    server.use(http.put('/api/flows/watch', () => refusal({ flow: ['The flow is not right.'], 'node:test': ['Pick a test.'], 'edge:e1': ['Not this wire.'] })));
    render(<FlowsPage />);
    const run = await screen.findByRole('checkbox', { name: 'Run it once deployed' });

    await userEvent.click(run);
    await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));
    expect(await screen.findByTitle('Pick a test.')).toHaveAttribute('data-problem');
    expect(screen.getByText('The flow is not right.')).toBeInTheDocument();

    await userEvent.click(run);

    expect(screen.getByText('All deployed')).toBeInTheDocument();
    expect(document.querySelector('[data-problem]')).toBeNull();
    expect(screen.queryByText('The flow is not right.')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Boiler watch/ })).not.toHaveAttribute('data-state', 'refused');

    await userEvent.click(run);

    expect(screen.getByText('1 change')).toBeInTheDocument();
    expect(document.querySelector('[data-problem]')).toBeNull();
    expect(screen.queryByText('The flow is not right.')).not.toBeInTheDocument();
  });
});
