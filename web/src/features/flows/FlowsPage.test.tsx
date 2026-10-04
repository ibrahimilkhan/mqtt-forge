import type { QueryClient } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Profiler, StrictMode } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '../../api/queryKeys';
import { useFlowAlarmStore } from '../../stores/flowAlarmStore';
import { useFlowStatusStore } from '../../stores/flowStatusStore';
import { useLogStore } from '../../stores/logStore';
import panelStyles from '../../styles/panel.module.css';
import { server } from '../../test/server';
import { renderWithClient as render } from '../../test/renderWithClient';
import type { FlowDebugDto, FlowDto, FlowNodeDto, FlowRunStatusDto, FlowsDto, FlowStatusDto } from '../../types/api';
import { namesOf } from './backWires';
import {
  forgetDrafts,
  MeasuredTogether,
  paneSized,
  runOf,
  standInForTheBrowser,
  viewport,
  withoutComments,
} from './canvasTestbed';
import { DebugStrip } from './DebugStrip';
import strip from './DebugStrip.module.css';
import stripSheet from './DebugStrip.module.css?raw';
import { exampleFlows } from './examples';
import { DECISION_HEIGHT, DECISION_WIDTH, NODE_HEIGHT, NODE_WIDTH, STEP_HEIGHT } from './FlowCanvas';
import { emptyFlow, GAP, moveNodes, ROW } from './flowDocument';
import { DRAFT_PREFIX, useFlowDraftStore } from './flowDraftStore';
import FlowsPage from './FlowsPage';
import inspector from './Inspector.module.css';
import inspectorSheet from './Inspector.module.css?raw';
import { NODE_SPECS } from './nodeTypes';
import toolbar from './Toolbar.module.css';
import toolbarSheet from './Toolbar.module.css?raw';

beforeAll(() => standInForTheBrowser());
afterAll(() => vi.unstubAllGlobals());

beforeEach(() => {
  localStorage.clear();
  forgetDrafts();
  useFlowStatusStore.setState(useFlowStatusStore.getInitialState());
  useFlowAlarmStore.setState({ asked: null });
  useLogStore.getState().clear();
});

/**
 * The flows the server has, each a whole flowchart, as the page saves one: every way out wired,
 * every node reached from the Start. The watch reads a message and asks whether it runs hot, and
 * either way the run ends there.
 */
const watch: FlowDto = {
  id: 'watch',
  name: 'Boiler watch',
  enabled: true,
  nodes: [
    { id: 'start', type: 'start', x: 40, y: 120, config: {} },
    { id: 'in', type: 'mqttIn', x: 260, y: 120, config: { filter: 'plant/+/temp', replay: false } },
    { id: 'test', type: 'if', x: 500, y: 120, config: { field: '$.temp', test: 'gt', value: '90', value2: '' } },
    { id: 'end', type: 'end', x: 800, y: 120, config: {} },
  ],
  edges: [
    { id: 'e0', from: 'start', fromPort: 'out', to: 'in', toPort: 'in' },
    { id: 'e1', from: 'in', fromPort: 'out', to: 'test', toPort: 'in' },
    { id: 'e2', from: 'test', fromPort: 'yes', to: 'end', toPort: 'in' },
    { id: 'e3', from: 'test', fromPort: 'no', to: 'end', toPort: 'in' },
  ],
  variables: [],
};

/** The simulator goes round for ever, two seconds a turn. */
const sim: FlowDto = {
  id: 'sim',
  name: 'Boiler simulator',
  enabled: true,
  nodes: [
    { id: 'start', type: 'start', x: 40, y: 100, config: {} },
    { id: 'loop', type: 'for', x: 240, y: 100, config: { times: '', forever: true } },
    { id: 'tick', type: 'wait', x: 480, y: 100, config: { seconds: '2' } },
    { id: 'end', type: 'end', x: 240, y: 280, config: {} },
  ],
  edges: [
    { id: 'e1', from: 'start', fromPort: 'out', to: 'loop', toPort: 'in' },
    { id: 'e2', from: 'loop', fromPort: 'body', to: 'tick', toPort: 'in' },
    { id: 'e3', from: 'tick', fromPort: 'out', to: 'loop', toPort: 'next' },
    { id: 'e4', from: 'loop', fromPort: 'done', to: 'end', toPort: 'in' },
  ],
  variables: [],
};

/** One run of the watch, as the server reports it: the flow at work, waiting, unless the test says otherwise. */
const watchRun = (over: Partial<FlowRunStatusDto> = {}): FlowRunStatusDto => runOf('watch', over);

/** What the server says the watch has done, with this many messages read. */
const watchHasSeen = (count: number): FlowStatusDto => ({
  runs: [watchRun({ nodes: [{ id: 'in', count, outs: { out: count }, errors: 0, note: null, standing: [] }] })],
});

/** What a stylesheet declares for one selector, its comments left out. */
function ruleOf(sheet: string, selector: string) {
  const rules = withoutComments(sheet);
  const at = rules.indexOf(`${selector} {`);
  return at < 0 ? '' : rules.slice(at + selector.length, rules.indexOf('}', at));
}

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

/**
 * Another console saves or deletes, and this one reads the list again. The query tells the page
 * a turn of the clock after the read comes back, so the turns are waited for too.
 */
async function elsewhere(queryClient: QueryClient, change: () => void) {
  change();
  await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.flows }));
  await turns();
}

/** The answer the server gives a save or a test it refuses. */
const refusal = (errors: Record<string, string[]>) =>
  HttpResponse.json(
    { title: 'The flow was not deployed', detail: Object.values(errors)[0][0], reason: 'flowInvalid', errors },
    { status: 400, headers: { 'Content-Type': 'application/problem+json' } },
  );

/** The answer the server gives a request it could not carry out: a file it could not write, say. */
const couldNot = (detail: string, status = 500) =>
  HttpResponse.json(
    { title: 'Could not do that', detail, reason: 'flowsNotSaved' },
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );

/** A server that keeps what it is sent, the way the real one does. `reads` counts the lists it has sent. */
function keeping(initial: FlowDto[] = [], over: Partial<FlowsDto> = {}) {
  const kept = [...initial];
  const puts: FlowDto[] = [];
  const deletes: string[] = [];
  let lists = 0;

  server.use(
    http.get('/api/flows', () => {
      lists++;
      return HttpResponse.json({ flows: kept, problems: [], unreadable: false, allowWebhooks: true, alertTopicPrefix: 'mqttforge/alerts/', ...over });
    }),
    http.put('/api/flows/:id', async ({ request }) => {
      const flow = (await request.json()) as FlowDto;
      puts.push(flow);
      const at = kept.findIndex((one) => one.id === flow.id);
      if (at >= 0) kept[at] = flow;
      else kept.push(flow);
      return HttpResponse.json({ flow });
    }),
    http.delete('/api/flows/:id', ({ params }) => {
      const id = String(params.id);
      deletes.push(id);
      const at = kept.findIndex((one) => one.id === id);
      if (at < 0)
        return HttpResponse.json(
          { title: 'No such flow', detail: `There is no flow '${id}' to delete.`, reason: 'flowUnknown' },
          { status: 404, headers: { 'Content-Type': 'application/problem+json' } },
        );
      kept.splice(at, 1);
      return new HttpResponse(null, { status: 204 });
    }),
  );

  return { kept, puts, deletes, reads: () => lists };
}

/** The list as the server sends it, with these flows and nothing wrong with any of them. */
const listOf = (flows: FlowDto[]): FlowsDto => ({
  flows,
  problems: [],
  unreadable: false,
  allowWebhooks: true,
  alertTopicPrefix: 'mqttforge/alerts/',
});

/** The flows the server of the case drawn last has, as renderPage serves them. */
let served: FlowDto[] = [];

/**
 * The page over a server that has these flows and answers nothing else of its own: a case that
 * presses a button answers what it sends with handlers of its own, which catch what was sent.
 */
function renderPage(flows: FlowDto[]) {
  served = flows;
  server.use(http.get('/api/flows', () => HttpResponse.json(listOf(served))));
  return render(<FlowsPage />);
}

/**
 * A reader's edit of a flow renderPage served, once the page has drawn it: to its draft, or to the
 * server's copy when it has none yet, which the draft is then of.
 */
async function edit(id: string, change: (flow: FlowDto) => FlowDto) {
  await screen.findByRole('tabpanel');
  act(() => useFlowDraftStore.getState().edit(served.find((flow) => flow.id === id)!, change));
}

/** A status push with one run of a flow, a test in this state. */
const testRun = (flowId: string, state: FlowRunStatusDto['state']): FlowStatusDto => ({
  runs: [runOf(flowId, { kind: 'test', state })],
});

/**
 * Another tab of this console lets a flow's draft go — discards it, or saves it — and this one
 * hears, as a browser tells the other tabs of one: by the key that changed in localStorage.
 */
function letGoOnAnotherTab(flowId: string) {
  const key = DRAFT_PREFIX + flowId;
  const oldValue = localStorage.getItem(key);
  localStorage.removeItem(key);
  act(() => window.dispatchEvent(new StorageEvent('storage', { key, oldValue, newValue: null, storageArea: localStorage })));
}

describe('Flows page', () => {
  it('offers an example and an empty flow when there are no flows', async () => {
    keeping();
    render(<FlowsPage />);

    expect(await screen.findByRole('button', { name: 'Start from an example' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New flow' })).toBeInTheDocument();
  });

  it('says on the empty page how a flow is drawn, tested and kept running', async () => {
    keeping();
    render(<FlowsPage />);

    expect(
      await screen.findByText(
        'Draw what should happen, step by step, from Start to End — read a message, decide, raise an alarm, publish an answer. Test runs the drawing once; Activate keeps it running on the server, with this page open or not.',
      ),
    ).toBeInTheDocument();
  });

  it('makes the two example flows as drafts, ready to test or activate', async () => {
    keeping();
    render(<FlowsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Start from an example' }));

    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      expect.stringContaining('Boiler simulator'),
      expect.stringContaining('Boiler watch'),
    ]);
    expect(screen.getByRole('tab', { name: 'Boiler simulator, not running, not saved' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Boiler watch, not running, not saved' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Activate' })).toBeInTheDocument();
    expect(await screen.findByText('2 s')).toBeInTheDocument();
  });

  it('marks what the server refused of an Activate, and keeps the draft', async () => {
    keeping([{ ...watch, enabled: false }]);
    server.use(
      http.put('/api/flows/watch', () => refusal({ 'node:test': ['Pick a test.'] })),
    );
    render(<FlowsPage />);

    await userEvent.type(await screen.findByLabelText('Name'), ' 2');
    await userEvent.click(screen.getByRole('button', { name: 'Activate' }));

    expect(await screen.findByTitle('Pick a test.')).toHaveAttribute('data-problem');
    expect(screen.getByRole('tab', { name: 'Boiler watch 2, not running, refused, changes not saved' })).toBeInTheDocument();
  });

  it('puts a flow back to what is running on Discard', async () => {
    keeping([watch]);
    render(<FlowsPage />);

    const name = await screen.findByLabelText('Name');
    await userEvent.type(name, ' 2');
    expect(screen.getByRole('tab', { name: /Boiler watch 2/ })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));

    expect(screen.getByRole('tab', { name: 'Boiler watch, not running' })).toBeInTheDocument();
    expect(useFlowDraftStore.getState().drafts.watch).toBeUndefined();
  });

  it('adds a node from the palette, picked and ready to set up', async () => {
    keeping([watch]);
    render(<FlowsPage />);

    await userEvent.click(within(await screen.findByRole('group', { name: 'Nodes' })).getByRole('button', { name: /Publish/ }));

    expect(screen.getByRole('heading', { name: 'Publish' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Boiler watch, not running, changes not saved' })).toBeInTheDocument();
  });

  // Three clicks are three nodes that can each be read and grabbed. Stepped a few pixels from the
  // last, each new node covered the title of the one before and hid its ports under its own.
  it('puts each node the palette adds where it covers no other', async () => {
    keeping();
    render(<FlowsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'New flow' }));
    const palette = within(screen.getByRole('group', { name: 'Nodes' }));

    for (const name of [/^MQTT in/, /^Debug/, /^Publish/]) await userEvent.click(palette.getByRole('button', { name }));

    const [flow] = Object.values(useFlowDraftStore.getState().drafts);
    const apart = (a: FlowNodeDto, b: FlowNodeDto) =>
      a.x + NODE_WIDTH <= b.x || b.x + NODE_WIDTH <= a.x || a.y + NODE_HEIGHT <= b.y || b.y + NODE_HEIGHT <= a.y;
    expect(flow.nodes.map((node) => node.type)).toEqual(['start', 'end', 'mqttIn', 'debug', 'publish']);
    for (const [i, a] of flow.nodes.entries())
      for (const b of flow.nodes.slice(i + 1)) expect(apart(a, b), `${a.type} and ${b.type} overlap`).toBe(true);
  });

  it('shows what the running flow has done under each node', async () => {
    keeping([watch]);
    server.use(
      http.get('/api/flows/status', () =>
        HttpResponse.json({
          runs: [watchRun({
            nodes: [
              { id: 'in', count: 412, outs: { out: 412 }, errors: 0, note: null, standing: [] },
              { id: 'test', count: 412, outs: { yes: 3, no: 409 }, errors: 0, note: null, standing: [] },
            ],
          })],
        }),
      ),
    );
    render(<FlowsPage />);

    expect(await screen.findByText('412 read')).toBeInTheDocument();
    expect(screen.getByText('yes 3 · no 409')).toBeInTheDocument();
    expect(screen.getByText('Active · waiting')).toBeInTheDocument();
  });

  // A reader who pressed Test is looking at the test, so the numbers under the nodes are the test's
  // while it goes, and the flow at work has the canvas back once the test is over.
  it('shows the numbers of a test while it goes, and of the flow at work once it has ended', async () => {
    keeping([watch]);
    render(<FlowsPage />);
    await screen.findByRole('tab', { name: /Boiler watch/ });
    const reading = (count: number) => [{ id: 'in', count, outs: { out: count }, errors: 0, note: null, standing: [] }];
    const atWork = watchRun({ nodes: reading(500) });
    const test = watchRun({ kind: 'test', state: 'running', nodes: reading(3) });

    act(() => useFlowStatusStore.getState().setStatus({ runs: [atWork, test] }));

    expect(await screen.findByText('3 read')).toBeInTheDocument();
    expect(screen.queryByText('500 read')).not.toBeInTheDocument();

    act(() => useFlowStatusStore.getState().setStatus({ runs: [atWork, { ...test, state: 'finished' }] }));

    expect(screen.getByText('500 read')).toBeInTheDocument();
    expect(screen.queryByText('3 read')).not.toBeInTheDocument();
  });

  it('says a flows file the server cannot read, and draws nothing over it', async () => {
    keeping([], { unreadable: true });
    render(<FlowsPage />);

    expect(await screen.findByText(/could not be read/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Test' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Activate' })).not.toBeInTheDocument();
  });

  // The canvas and the inspector are both made again for each flow, and siblings that share a key
  // leave React unable to tell them apart: every tab shown left its canvas behind in the page,
  // five canvases after five tabs, the inspector pushed down under them.
  it('draws one canvas and one inspector, whichever tabs were shown before', async () => {
    keeping([watch, sim]);
    render(<FlowsPage />);
    await screen.findByRole('tab', { name: /Boiler watch/ });

    await userEvent.click(screen.getByRole('tab', { name: /Boiler simulator/ }));
    await userEvent.click(screen.getByRole('tab', { name: /Boiler watch/ }));
    await userEvent.click(screen.getByRole('tab', { name: /Boiler simulator/ }));

    expect(document.querySelectorAll('.react-flow')).toHaveLength(1);
    expect(document.querySelectorAll('#flow-canvas')).toHaveLength(1);
    expect(document.querySelectorAll('aside')).toHaveLength(1);
  });

  it('makes a new flow from beside the tabs, and shows it', async () => {
    keeping([watch]);
    render(<FlowsPage />);
    await screen.findByRole('tab', { name: /Boiler watch/ });

    await userEvent.click(screen.getByRole('button', { name: 'New flow' }));

    expect(screen.getByRole('tab', { name: 'Flow 1, not running, not saved', selected: true })).toBeInTheDocument();
    // A tab list owns tabs and nothing else, so the button that adds one stands beside it.
    expect(within(screen.getByRole('tablist')).queryAllByRole('button')).toEqual([]);
  });

  // Back to what is running means nothing for a flow that has never run. Throwing the whole flow
  // away is what Delete flow does, and that asks first.
  it('offers no Discard for a flow that was never saved', async () => {
    keeping();
    render(<FlowsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Start from an example' }));

    expect(screen.getByRole('tab', { name: 'Boiler simulator, not running, not saved' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Discard' })).not.toBeInTheDocument();
  });

  // What was typed while the request was out is newer than what went, and was never saved.
  it('keeps what was typed while a save was on its way', async () => {
    const { kept } = keeping([watch]);
    const answer = held();
    server.use(
      http.put('/api/flows/:id', async ({ request }) => {
        const flow = (await request.json()) as FlowDto;
        await answer.until;
        kept[0] = flow;
        return HttpResponse.json({ flow });
      }),
    );
    render(<FlowsPage />);
    const update = () => screen.getByRole('button', { name: 'Update' });

    const name = await screen.findByLabelText('Name');
    await userEvent.type(name, ' 2');
    await userEvent.click(update());
    await waitFor(() => expect(update()).toHaveAttribute('aria-disabled', 'true'));

    await userEvent.type(name, 'b');
    answer.release();

    await waitFor(() => expect(update()).not.toHaveAttribute('aria-disabled'));
    expect(kept[0].name).toBe('Boiler watch 2');
    expect(screen.getByRole('tab', { name: 'Boiler watch 2b, not running, changes not saved' })).toBeInTheDocument();
  });

  // Taken back to the copy the server had while the change was on its way, the draft is not
  // nothing: the server is about to have the change, and what was typed says to undo it.
  it('keeps an edit taken back while the save of it was on its way', async () => {
    const { kept } = keeping([watch]);
    const answer = held();
    server.use(
      http.put('/api/flows/:id', async ({ request }) => {
        const flow = (await request.json()) as FlowDto;
        await answer.until;
        kept[0] = flow;
        return HttpResponse.json({ flow });
      }),
    );
    render(<FlowsPage />);
    const update = () => screen.getByRole('button', { name: 'Update' });

    const name = await screen.findByLabelText('Name');
    await userEvent.type(name, ' 2');
    await userEvent.click(update());
    await waitFor(() => expect(update()).toHaveAttribute('aria-disabled', 'true'));
    await userEvent.type(name, '{Backspace}{Backspace}');
    answer.release();

    await waitFor(() => expect(update()).not.toHaveAttribute('aria-disabled'));
    expect(kept[0].name).toBe('Boiler watch 2');
    expect(screen.getByRole('tab', { name: 'Boiler watch, not running, changes not saved' })).toBeInTheDocument();
  });

  it('says when the flows cannot be read at all', async () => {
    server.use(http.get('/api/flows', () => HttpResponse.json({ title: 'Server error' }, { status: 500 })));
    render(<FlowsPage />);

    expect(await screen.findByText(/The flows could not be read from the server/)).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });

  // A read that fails once the flows are on screen takes nothing away: the drafts are all still
  // here, and a save says for itself when the server is not there.
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
        [{ flowId: 'watch', nodeId: 'in', at: '2026-09-26T09:14:22Z', kind: 'message', topic: 'plant/k1/temp', text: '{"temp":94.2}', test: false }],
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

  // React may run a state updater twice, and StrictMode always does. A write inside one ran twice
  // with it; a press writes the fold once.
  it('writes the fold once for each press, even where React runs its updaters twice', async () => {
    const writes = vi.spyOn(Storage.prototype, 'setItem');
    render(
      <StrictMode>
        <DebugStrip flow={watch} />
      </StrictMode>,
    );

    await userEvent.click(within(screen.getByRole('region', { name: 'Debug' })).getByRole('button', { name: /Debug/ }));
    const folds = writes.mock.calls.filter(([key]) => key === 'mqttforge.flows.debugOpen');
    writes.mockRestore();

    expect(folds).toEqual([['mqttforge.flows.debugOpen', '0']]);
  });
});

/**
 * A click in the palette puts the node where the program needs it: on the wire picked, or after the
 * node picked when it has one way out, and the node it puts down is picked in turn — so a chain is
 * built by clicking one node after another, each wired in as it lands.
 */
describe('the palette builds a chain', () => {
  // The palette's own items: the debug strip's fold under the canvas is a button named Debug too.
  const palette = () => within(screen.getByRole('group', { name: 'Nodes' }));

  it('puts a node on the picked wire', async () => {
    const flow = { ...emptyFlow('Flow 1'), id: 'f1' };
    renderPage([flow]);
    await screen.findByRole('button', { name: 'Test' });

    act(() => useFlowDraftStore.getState().pickWire(flow.edges[0].id));
    fireEvent.click(palette().getByRole('button', { name: /^Publish/ }));

    const draft = useFlowDraftStore.getState().drafts.f1;
    const publish = draft.nodes.find((node) => node.type === 'publish')!;
    expect(draft.edges.map((edge) => `${edge.from}>${edge.to}`).sort()).toEqual(
      [`start>${publish.id}`, `${publish.id}>${flow.nodes[1].id}`].sort(),
    );
  });

  it('puts a node after the picked one, and picks it, so the next goes after that', async () => {
    const flow = { ...emptyFlow('Flow 1'), id: 'f1' };
    renderPage([flow]);
    await screen.findByRole('button', { name: 'Test' });

    act(() => useFlowDraftStore.getState().select('start'));
    fireEvent.click(palette().getByRole('button', { name: /^MQTT in/ }));
    fireEvent.click(palette().getByRole('button', { name: /^Debug/ }));

    const draft = useFlowDraftStore.getState().drafts.f1;
    const types = (id: string) => draft.nodes.find((node) => node.id === id)!.type;
    const chain: string[] = [];
    for (let at: string | undefined = 'start'; at; at = draft.edges.find((edge) => edge.from === at)?.to) chain.push(types(at));
    expect(chain).toEqual(['start', 'mqttIn', 'debug', 'end']);
  });

  it('leaves the Start out of the palette', async () => {
    renderPage([{ ...emptyFlow('Flow 1'), id: 'f1' }]);
    await screen.findByRole('button', { name: 'Test' });

    expect(screen.queryByRole('button', { name: /^Start/ })).toBeNull();
    expect(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual(
      expect.arrayContaining(['Input', 'Control', 'Actions', 'Alarm']),
    );
  });

  /** A flow's draft, once the palette has put something in it. */
  const draftOf = (id: string) => useFlowDraftStore.getState().drafts[id];

  /** The room a node takes as the page reckons it: an If's diamond a box of its own, every other node a step's. */
  const roomOf = (node: FlowNodeDto) =>
    node.type === 'if' ? { width: DECISION_WIDTH, height: DECISION_HEIGHT } : { width: NODE_WIDTH, height: NODE_HEIGHT };

  /** Whether two nodes stand the palette's room apart — the 24 it keeps between the nodes it puts down and the rest — by their own boxes. */
  const roomApart = (a: FlowNodeDto, b: FlowNodeDto) =>
    a.x + roomOf(a).width + 24 <= b.x ||
    b.x + roomOf(b).width + 24 <= a.x ||
    a.y + roomOf(a).height + 24 <= b.y ||
    b.y + roomOf(b).height + 24 <= a.y;

  // The If is drawn in a box of its own, wider and taller than a step's. Reckoned as a step, its lower
  // half was free ground, and the next node went down onto it.
  it('keeps a node it puts after another clear of an If standing there, by the If’s own box', async () => {
    const flow = { ...emptyFlow('Flow 1'), id: 'f1' };
    renderPage([flow]);
    await screen.findByRole('button', { name: 'Test' });

    act(() => useFlowDraftStore.getState().select('start'));
    fireEvent.click(palette().getByRole('button', { name: /^MQTT in/ }));
    fireEvent.click(palette().getByRole('button', { name: /^If/ }));
    const read = draftOf('f1').nodes.find((node) => node.type === 'mqttIn')!;
    act(() => useFlowDraftStore.getState().select(read.id));
    fireEvent.click(palette().getByRole('button', { name: /^Debug/ }));

    const test = draftOf('f1').nodes.find((node) => node.type === 'if')!;
    const say = draftOf('f1').nodes.find((node) => node.type === 'debug')!;
    expect(roomApart(say, test), `Debug at ${say.x},${say.y}, If at ${test.x},${test.y}`).toBe(true);
  });

  it('keeps a node it puts after the watch’s Debug clear of the If after it', async () => {
    const watching = { ...exampleFlows()[1], id: 'w' };
    renderPage([watching]);
    await screen.findByRole('button', { name: 'Test' });

    act(() => useFlowDraftStore.getState().select('say'));
    fireEvent.click(palette().getByRole('button', { name: /^Publish/ }));

    const added = draftOf('w').nodes.find((node) => !watching.nodes.some((one) => one.id === node.id))!;
    const test = draftOf('w').nodes.find((node) => node.id === 'test')!;
    expect(roomApart(added, test), `Publish at ${added.x},${added.y}, If at ${test.x},${test.y}`).toBe(true);
  });

  // The examples' own rule: a node's ports stand at half its height, so an If, taller than a step,
  // stands higher by half the difference, and the wire between them runs level.
  it('levels an If it puts after a step with that step', async () => {
    const flow = { ...emptyFlow('Flow 1'), id: 'f1' };
    // The End out of the way, so the place beside the Start is free.
    renderPage([{ ...flow, nodes: [flow.nodes[0], { ...flow.nodes[1], x: 900, y: 400 }] }]);
    await screen.findByRole('button', { name: 'Test' });

    act(() => useFlowDraftStore.getState().select('start'));
    fireEvent.click(palette().getByRole('button', { name: /^If/ }));

    const [start, , test] = draftOf('f1').nodes;
    expect(test.type).toBe('if');
    expect(Math.abs(test.y + DECISION_HEIGHT / 2 - (start.y + STEP_HEIGHT / 2))).toBeLessThan(0.5);
  });

  /** How tall a node is drawn: the If's diamond in its own box, every other shape a step's. */
  const tallness = (node: FlowNodeDto) => (node.type === 'if' ? DECISION_HEIGHT : STEP_HEIGHT);

  /** Whether two nodes stand clear of each other as the canvas draws them. */
  const clearOf = (a: FlowNodeDto, b: FlowNodeDto) =>
    a.x + roomOf(a).width <= b.x || b.x + roomOf(b).width <= a.x || a.y + tallness(a) <= b.y || b.y + tallness(b) <= a.y;

  /** Every two nodes of a flow that stand on one another. */
  const overlapping = (flow: FlowDto) =>
    flow.nodes.flatMap((a, at) => flow.nodes.slice(at + 1).filter((b) => !clearOf(a, b)).map((b) => `${a.id} on ${b.id}`));

  // The place beside the node a click follows was taken — a new flow's End stands there — and the
  // palette stepped the node a row down. A chain clicked together from the Start went down a row with
  // each click, and its last wire went back up to the End. It makes room instead: what comes after
  // moves along the row, the End with it.
  it('keeps a chain clicked together from the Start on one row, the End at its end, nothing overlapping', async () => {
    const flow = { ...emptyFlow('Flow 1'), id: 'f1' };
    renderPage([flow]);
    await screen.findByRole('button', { name: 'Test' });

    act(() => useFlowDraftStore.getState().select('start'));
    for (const name of [/^MQTT in/, /^Debug/, /^If/, /^Publish/]) fireEvent.click(palette().getByRole('button', { name }));

    const draft = draftOf('f1');
    const chain: FlowNodeDto[] = [];
    for (let at: string | undefined = 'start'; at; at = draft.edges.find((edge) => edge.from === at && edge.fromPort !== 'no')?.to)
      chain.push(draft.nodes.find((node) => node.id === at)!);
    expect(chain.map((node) => node.type)).toEqual(['start', 'mqttIn', 'debug', 'if', 'end']);
    // Level, each a gap or more past the one before, so every wire along it runs straight and forward.
    for (const node of chain) expect(Math.abs(node.y + tallness(node) / 2 - (120 + STEP_HEIGHT / 2)), node.type).toBeLessThan(0.5);
    for (const [at, node] of chain.slice(1).entries()) expect(node.x - (chain[at].x + roomOf(chain[at]).width)).toBeGreaterThanOrEqual(GAP);
    // The If picked has two ways out, so the Publish went down on its own, clear of the rest.
    expect(overlapping(draft)).toEqual([]);
  });

  it('makes room after the watch’s Debug: what comes after it moves along, and nothing overlaps', async () => {
    const watching = { ...exampleFlows()[1], id: 'w' };
    renderPage([watching]);
    await screen.findByRole('button', { name: 'Test' });

    act(() => useFlowDraftStore.getState().select('say'));
    fireEvent.click(palette().getByRole('button', { name: /^Publish/ }));

    const draft = draftOf('w');
    const say = watching.nodes.find((node) => node.id === 'say')!;
    const added = draft.nodes.find((node) => !watching.nodes.some((one) => one.id === node.id))!;
    expect({ x: added.x, y: added.y }).toEqual({ x: say.x + NODE_WIDTH + GAP, y: say.y });

    // Everything a run gets to after the Debug moves along by the Publish and a gap; the rest stays.
    const after = new Set(['test', 'hot', 'beep', 'tell', 'fan', 'cool']);
    for (const node of watching.nodes) {
      const now = draft.nodes.find((one) => one.id === node.id)!;
      expect({ x: now.x, y: now.y }, node.id).toEqual({ x: node.x + (after.has(node.id) ? NODE_WIDTH + GAP : 0), y: node.y });
    }
    expect(overlapping(draft)).toEqual([]);
  });

  // A way out at a node's foot leads down, as the examples' do. Beside the node is where its other way
  // out goes — the loop's body — and a node put there for its done looked like the body, and stood
  // across the body's wire.
  it('puts a node on a way out at a foot on the row under its node, and moves along what that way led to', async () => {
    const watching = { ...exampleFlows()[1], id: 'w' };
    renderPage([watching]);
    await screen.findByRole('button', { name: 'Test' });

    act(() => useFlowDraftStore.getState().pickWire('e14'));
    fireEvent.click(palette().getByRole('button', { name: /^Debug/ }));

    const draft = draftOf('w');
    const loop = watching.nodes.find((node) => node.id === 'loop')!;
    const end = watching.nodes.find((node) => node.id === 'end')!;
    const added = draft.nodes.find((node) => node.type === 'debug' && node.id !== 'say')!;
    // A row under the For, its way in a little to the right of the For's done.
    expect({ x: added.x, y: added.y }).toEqual({ x: loop.x + NODE_WIDTH / 2 + GAP / 2, y: loop.y + ROW });
    expect(draft.nodes.find((node) => node.id === 'end')).toMatchObject({ x: end.x + NODE_WIDTH + GAP, y: end.y });
    expect(overlapping(draft)).toEqual([]);
  });

  // A loop's body is named beside its way out, past where a wire going back turns up. Put 48 along, a
  // node stood on the name.
  it('puts a node after a named way out far enough along that the name stands clear of it', async () => {
    const flow = { ...emptyFlow('Flow 1'), id: 'f1' };
    renderPage([flow]);
    await screen.findByRole('button', { name: 'Test' });

    act(() => useFlowDraftStore.getState().select('start'));
    fireEvent.click(palette().getByRole('button', { name: /^For(?! each)/ }));
    const loop = draftOf('f1').nodes.find((node) => node.type === 'for')!;
    // As a click on the wire does: the For lets go, and the wire is picked alone.
    act(() => {
      useFlowDraftStore.getState().select(null);
      useFlowDraftStore.getState().pickWire(draftOf('f1').edges.find((edge) => edge.fromPort === 'body')!.id);
    });
    fireEvent.click(palette().getByRole('button', { name: /^Debug/ }));

    const say = draftOf('f1').nodes.find((node) => node.type === 'debug')!;
    const box = { x: loop.x, y: loop.y, width: NODE_WIDTH, height: STEP_HEIGHT };
    const [body] = namesOf(box, 'for', NODE_SPECS.for, []).filter((name) => name.x > box.x + box.width);
    expect(say.x - (body.x + body.width)).toBeGreaterThanOrEqual(24);
  });

  // A loop's empty body is a wire from the loop back into it, so half-way along it is the loop itself:
  // a node put there stepped down under the loop, and both its wires went round the loop to reach it.
  it('puts a node on a loop’s empty body after the loop, level with it, as a body is drawn', async () => {
    const looping: FlowDto = {
      ...emptyFlow('Flow 1'),
      id: 'f1',
      nodes: [
        { id: 'start', type: 'start', x: 40, y: 120, config: {} },
        { id: 'loop', type: 'for', x: 324, y: 120, config: { times: '3', forever: false } },
        { id: 'end', type: 'end', x: 324, y: 300, config: {} },
      ],
      edges: [
        { id: 'e1', from: 'start', fromPort: 'out', to: 'loop', toPort: 'in' },
        { id: 'e2', from: 'loop', fromPort: 'body', to: 'loop', toPort: 'next' },
        { id: 'e3', from: 'loop', fromPort: 'done', to: 'end', toPort: 'in' },
      ],
    };
    renderPage([looping]);
    await screen.findByRole('button', { name: 'Test' });

    act(() => useFlowDraftStore.getState().pickWire('e2'));
    fireEvent.click(palette().getByRole('button', { name: /^Debug/ }));

    const say = draftOf('f1').nodes.find((node) => node.type === 'debug')!;
    expect({ x: say.x, y: say.y }).toEqual({ x: 324 + NODE_WIDTH + GAP, y: 120 });
    expect(draftOf('f1').edges.map((edge) => `${edge.from}.${edge.fromPort}>${edge.to}.${edge.toPort}`).sort()).toEqual(
      ['start.out>loop.in', `loop.body>${say.id}.in`, `${say.id}.out>loop.next`, 'loop.done>end.in'].sort(),
    );
  });

  // A chain clicked together runs right, and its last wire goes back to the End where the new flow
  // had it. Half-way along that wire is behind the chain's last node: what is put on it goes after
  // that node, as the chain's next step.
  it('puts a node on a wire that goes back after the node the wire leaves', async () => {
    const flow = { ...emptyFlow('Flow 1'), id: 'f1' };
    const end = flow.nodes[1];
    renderPage([
      {
        ...flow,
        nodes: [flow.nodes[0], { id: 'say', type: 'debug', x: 600, y: 120, config: {} }, { ...end, x: 320, y: 300 }],
        edges: [
          { id: 'e1', from: 'start', fromPort: 'out', to: 'say', toPort: 'in' },
          { id: 'e2', from: 'say', fromPort: 'out', to: end.id, toPort: 'in' },
        ],
      },
    ]);
    await screen.findByRole('button', { name: 'Test' });

    act(() => useFlowDraftStore.getState().pickWire('e2'));
    fireEvent.click(palette().getByRole('button', { name: /^Publish/ }));

    const send = draftOf('f1').nodes.find((node) => node.type === 'publish')!;
    expect({ x: send.x, y: send.y }).toEqual({ x: 600 + NODE_WIDTH + GAP, y: 120 });
  });

  // Which of an If's two ways out the reader meant is theirs to say, by picking its wire.
  it('puts a node free, wired to nothing, when the node picked has two ways out', async () => {
    renderPage([watch]);
    await screen.findByRole('tabpanel');

    act(() => useFlowDraftStore.getState().select('test'));
    fireEvent.click(palette().getByRole('button', { name: /^Debug/ }));

    const draft = draftOf('watch');
    const say = draft.nodes.find((node) => node.type === 'debug')!;
    expect(draft.edges).toEqual(watch.edges);
    expect(useFlowDraftStore.getState().selected).toBe(say.id);
  });

  // Discard takes back the change, and the pick with it: the next click must not land on a wire the
  // canvas no longer shows picked, though the flow put back has a wire of that id.
  it('does not put a node on a wire picked before a Discard', async () => {
    renderPage([watch]);
    await edit('watch', (flow) => moveNodes(flow, { end: { x: 900, y: 300 } }));
    act(() => useFlowDraftStore.getState().pickWire('e1'));

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    fireEvent.click(palette().getByRole('button', { name: /^Publish/ }));

    const draft = draftOf('watch');
    expect(draft.nodes.map((node) => node.type)).toEqual(['start', 'mqttIn', 'if', 'end', 'publish']);
    expect(draft.edges).toEqual(watch.edges);
  });

  /**
   * The canvas fits the flow when it opens, and not again: a chain clicked past the edge of the view
   * would go on growing out of sight, each click seeming to do nothing. A node put down out of view is
   * brought into it, at the zoom the reader has; one put down in view leaves the view as it is.
   */
  describe('in view', () => {
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

    it('pans to a node it puts down out of sight, at the zoom it had, and leaves the view alone for one in sight', async () => {
      const flow = { ...emptyFlow('Flow 1'), id: 'f1' };
      renderPage([flow]);
      await screen.findByRole('button', { name: 'Test' });
      // Fitted: the Start at 40 and the End at 360, a pixel square each in jsdom, round the middle at 1.
      await waitFor(() => expect(viewport()[0]).toBeCloseTo(400 - (40 + 361) / 2));
      const fitted = viewport();

      act(() => useFlowDraftStore.getState().select('start'));
      fireEvent.click(palette().getByRole('button', { name: /^MQTT in/ }));
      // Beside the Start, where the End stood, the End moved on along the row: in sight.
      expect(viewport()).toEqual(fitted);

      fireEvent.click(palette().getByRole('button', { name: /^Debug/ }));
      const say = draftOf('f1').nodes.find((node) => node.type === 'debug')!;
      // Past the right edge, 600 in at a zoom of 1: brought to the middle of the view, the zoom as it was.
      await waitFor(() => {
        const [x, y, zoom] = viewport();
        expect(zoom).toBe(fitted[2]);
        expect(x + (say.x + NODE_WIDTH / 2) * zoom).toBeCloseTo(400);
        expect(y + (say.y + NODE_HEIGHT / 2) * zoom).toBeCloseTo(300);
      });
    });
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

  it('goes to the tab when Activate becomes Deactivate', async () => {
    keeping([{ ...watch, enabled: false }]);
    render(<FlowsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Activate' }));

    expect(await screen.findByRole('button', { name: 'Deactivate' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Activate' })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(shownTab());
  });

  it('goes to the tab when Deactivate becomes Activate', async () => {
    keeping([watch]);
    render(<FlowsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Deactivate' }));

    expect(await screen.findByRole('button', { name: 'Activate' })).toBeInTheDocument();
    expect(document.activeElement).toBe(shownTab());
  });

  it('goes to the tab when Update has saved the change, and goes with it', async () => {
    keeping([watch]);
    render(<FlowsPage />);
    await userEvent.type(await screen.findByLabelText('Name'), ' 2');

    await userEvent.click(screen.getByRole('button', { name: 'Update' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Update' })).not.toBeInTheDocument());
    expect(document.activeElement).toBe(shownTab());
  });

  // Stop is not Test with another word on it: a second press of the key that started the test would
  // stop it again.
  it('goes to the tab when Test becomes Stop', async () => {
    keeping([watch]);
    let started = false;
    server.use(
      http.post('/api/flows/:id/test', () => {
        started = true;
        return new HttpResponse(null, { status: 202 });
      }),
    );
    render(<FlowsPage />);
    const test = () => screen.getByRole('button', { name: 'Test' });

    await userEvent.click(await screen.findByRole('button', { name: 'Test' }));
    await waitFor(() => expect(started).toBe(true));
    await turns();
    // Held off until the numbers show the test, with the keyboard still on it.
    expect(test()).toHaveAttribute('aria-disabled', 'true');
    expect(document.activeElement).toBe(test());

    act(() => useFlowStatusStore.getState().setStatus(testRun('watch', 'running')));

    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(document.activeElement).toBe(shownTab());
  });

  // A button that is switched off while it has the focus loses it in some browsers, so while a save
  // is out Activate only says it is off, and answers no press — and so does every button beside it.
  // A refusal leaves them on again, with the reader still on Activate.
  it('stays on Activate while the save is out, and after a refusal', async () => {
    const { puts } = keeping([{ ...watch, enabled: false }]);
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
    const activate = screen.getByRole('button', { name: 'Activate' });

    await userEvent.click(activate);
    await waitFor(() => expect(activate).toHaveAttribute('aria-disabled', 'true'));
    expect(activate).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Test' })).toHaveAttribute('aria-disabled', 'true');
    expect(document.activeElement).toBe(activate);
    await userEvent.click(activate);

    answer.release();
    expect(await screen.findByTitle('Pick a test.')).toBeInTheDocument();
    await waitFor(() => expect(activate).not.toHaveAttribute('aria-disabled'));
    expect(document.activeElement).toBe(activate);
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

  // Remove node takes its own pane away with the node. The reader was working on the canvas.
  it('goes to the canvas when Remove node takes the node away', async () => {
    keeping([watch]);
    render(<FlowsPage />);
    await screen.findByRole('tabpanel');
    fireEvent.click(
      (await within(document.getElementById('flow-canvas')!).findByText('If')).closest<HTMLElement>('.react-flow__node')!,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Remove node' }));

    expect(useFlowDraftStore.getState().drafts.watch.nodes.map((node) => node.id)).toEqual(['start', 'in', 'end']);
    expect(document.activeElement).toBe(document.getElementById('flow-canvas'));
  });

  // The question goes with the flow it was about, and the flow's pane with it.
  it('goes to the tab of the flow now on screen when a flow is deleted', async () => {
    keeping([watch, sim]);
    render(<FlowsPage />);
    await screen.findByText('Boiler watch', { selector: 'h3' });

    await userEvent.click(screen.getByRole('button', { name: 'Delete flow' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete it' }));

    expect(await screen.findByText('Boiler simulator', { selector: 'h3' })).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(shownTab()));
  });

  it('goes to the first way to start again when the last flow is deleted', async () => {
    keeping([watch]);
    render(<FlowsPage />);
    await screen.findByText('Boiler watch', { selector: 'h3' });

    await userEvent.click(screen.getByRole('button', { name: 'Delete flow' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete it' }));

    const start = await screen.findByRole('button', { name: 'Start from an example' });
    await waitFor(() => expect(document.activeElement).toBe(start));
  });
});

/**
 * Backspace and Delete take away what is picked on the canvas, and only from the canvas. A node
 * stays picked while the reader goes on to a tab, to the buttons beside the tabs or to the palette,
 * and a Backspace pressed there is about that control: taking the node away would lose it out of
 * sight.
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

    await waitFor(() => expect(useFlowDraftStore.getState().drafts.watch?.nodes.map((one) => one.id)).toEqual(['start', 'in', 'end']));
  });

  it('leave the picked node alone while the keyboard is on a tab, or on a button above the canvas', async () => {
    keeping([watch]);
    render(<FlowsPage />);
    // A change, so there is a Discard and an Update to be on.
    await userEvent.type(await screen.findByLabelText('Name'), ' 2');
    fireEvent.click(await drawn('If'));
    expect(useFlowDraftStore.getState().selected).toBe('test');

    const buttons = ['Discard', 'Test', 'Update', 'Deactivate'].map((name) => screen.getByRole('button', { name }));
    for (const control of [shownTab(), ...buttons]) {
      act(() => control.focus());
      await userEvent.keyboard('{Backspace}{Delete}');
      // Give anything the keys set going its turns before saying they took nothing.
      await turns();
    }

    expect(useFlowDraftStore.getState().drafts.watch.nodes.map((one) => one.id)).toEqual(['start', 'in', 'test', 'end']);
    expect(useFlowDraftStore.getState().selected).toBe('test');
  });
});

describe('the tabs', () => {
  // The lamp and the dot are drawn, and hidden from a screen reader, so the tab says in words what
  // they say. A flow that is running an older version of itself is not "not saved": its edits are.
  // A flow the server does not have can run too, in a test, so whether it runs is said of it as well.
  it('say in their names whether each flow runs, and what of it is not saved', async () => {
    keeping([watch]);
    server.use(http.get('/api/flows/status', () => HttpResponse.json(watchHasSeen(0))));
    render(<FlowsPage />);

    expect(await screen.findByRole('tab', { name: 'Boiler watch, running' })).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Name'), ' 2');
    expect(screen.getByRole('tab', { name: 'Boiler watch 2, running, changes not saved' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'New flow' }));
    expect(screen.getByRole('tab', { name: 'Flow 1, not running, not saved' })).toBeInTheDocument();
  });

  // A run that finished at its End, or was stopped, stays in what the server reports until something
  // replaces it, so a flow being in the picture no longer says the flow is going. A test that is going is
  // the run the canvas shows, and it is drawn as going.
  it('say a flow is running only while the run on show is going or waiting', async () => {
    keeping([watch]);
    render(<FlowsPage />);
    const tab = (state: string) => screen.getByRole('tab', { name: `Boiler watch, ${state}` });
    const report = (...runs: FlowRunStatusDto[]) => act(() => useFlowStatusStore.getState().setStatus({ runs }));
    await screen.findByRole('tab', { name: 'Boiler watch, not running' });

    report(watchRun({ state: 'running' }));
    expect(tab('running')).toBeInTheDocument();

    report(watchRun({ state: 'waiting' }));
    expect(tab('running')).toBeInTheDocument();

    report(watchRun({ state: 'finished' }));
    expect(tab('not running')).toBeInTheDocument();

    report(watchRun({ state: 'stopped' }));
    expect(tab('not running')).toBeInTheDocument();

    report(watchRun({ state: 'finished' }), watchRun({ kind: 'test', state: 'running' }));
    expect(tab('running')).toBeInTheDocument();

    report(watchRun({ state: 'finished' }), watchRun({ kind: 'test', state: 'finished' }));
    expect(tab('not running')).toBeInTheDocument();
  });

  it('say when a flow is not running, and when the server refused its changes', async () => {
    keeping([watch]);
    server.use(http.put('/api/flows/watch', () => refusal({ 'node:test': ['Pick a test.'] })));
    render(<FlowsPage />);

    expect(await screen.findByRole('tab', { name: 'Boiler watch, not running' })).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Name'), ' 2');
    await userEvent.click(screen.getByRole('button', { name: 'Update' }));

    expect(
      await screen.findByRole('tab', { name: 'Boiler watch 2, not running, refused, changes not saved' }),
    ).toBeInTheDocument();
  });

  // A refused Update leaves the flow running what it ran before, and the tab says both.
  it('go on saying a flow runs when the server refuses its changes', async () => {
    keeping([watch]);
    server.use(
      http.get('/api/flows/status', () => HttpResponse.json(watchHasSeen(0))),
      http.put('/api/flows/watch', () => refusal({ 'node:test': ['Pick a test.'] })),
    );
    render(<FlowsPage />);
    await screen.findByRole('tab', { name: 'Boiler watch, running' });

    await userEvent.type(screen.getByLabelText('Name'), ' 2');
    await userEvent.click(screen.getByRole('button', { name: 'Update' }));

    expect(
      await screen.findByRole('tab', { name: 'Boiler watch 2, running, refused, changes not saved' }),
    ).toBeInTheDocument();
  });

  // A colour on its own says nothing to a reader who cannot tell these apart, so each state has a
  // lamp of its own shape: a running flow a filled dot, a refused one the rail's warning triangle,
  // any other an empty ring.
  it('draw each state of a flow with a lamp of its own shape', async () => {
    keeping([watch, sim]);
    server.use(
      http.get('/api/flows/status', () => HttpResponse.json(watchHasSeen(0))),
      http.put('/api/flows/watch', () => refusal({ 'node:test': ['Pick a test.'] })),
    );
    render(<FlowsPage />);
    const lamp = (name: RegExp) => screen.getByRole('tab', { name }).querySelector(`.${toolbar.lamp}`)!;
    await screen.findByRole('tab', { name: /^Boiler watch, running/ });

    expect(lamp(/^Boiler watch/).querySelector('svg')).toBeNull();
    expect(lamp(/^Boiler simulator/).querySelector('svg')).toBeNull();
    expect(ruleOf(toolbarSheet, '.lamp')).toMatch(/border:/);
    expect(ruleOf(toolbarSheet, ".tab[data-state='running'] .lamp")).toMatch(/background:/);

    await userEvent.type(screen.getByLabelText('Name'), ' 2');
    await userEvent.click(screen.getByRole('button', { name: 'Update' }));
    await screen.findByTitle('Pick a test.');

    expect(lamp(/^Boiler watch 2/).querySelector('svg')).not.toBeNull();
  });

  it('control one panel, which the tab on show names', async () => {
    keeping([watch, sim]);
    render(<FlowsPage />);
    await screen.findByText('Boiler watch', { selector: 'h3' });

    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAttribute('aria-labelledby', shownTab().id);
    expect(panel).toHaveAccessibleName(/^Boiler watch/);
    for (const tab of screen.getAllByRole('tab')) expect(tab).toHaveAttribute('aria-controls', panel.id);
    expect(within(panel).getByRole('group', { name: 'Nodes' })).toBeInTheDocument();
    expect(within(panel).getByRole('complementary', { name: 'Inspector' })).toBeInTheDocument();
    expect(within(panel).getByRole('region', { name: 'Debug' })).toBeInTheDocument();
  });

  // One stop on the Tab key for the whole list, and the arrows to go along it — the way every tab
  // list is used. Showing a flow is instant, so the flow goes on screen as its tab takes the focus.
  it('go along with the arrow keys, Home and End, and show the flow they land on', async () => {
    const fan: FlowDto = { id: 'fan', name: 'Fan', enabled: true, nodes: [], edges: [], variables: [] };
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
  flowId, nodeId: 'in', at: '2026-09-26T09:14:22Z', kind: 'message', topic: 'plant/k1/temp', text, test: false, ...over,
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

    // Said quieter than what was printed, so the words cannot be taken for a topic or a payload.
    expect(within(empty).getByText('no topic')).toHaveClass(strip.none);
    expect(within(empty).getByText('empty payload')).toHaveClass(strip.none);
    expect(within(error).getByText('The flow stopped.')).not.toHaveClass(strip.none);
    expect(withoutComments(stripSheet)).toMatch(/\.none\s*\{[^}]*[{;\s]color:\s*var\(--muted\)/);
  });

  // The line's colour says it is an error only to a reader who can tell its red from the ink.
  it('says in a word which lines are errors', async () => {
    keeping([watch]);
    render(<FlowsPage />);
    await screen.findByText('Boiler watch', { selector: 'h3' });

    act(() =>
      useFlowStatusStore.getState().addDebug([printed('watch', 'w1'), printed('watch', 'no such field', { kind: 'error' })], 0),
    );

    const error = within(debugStrip()).getByText('no such field').closest('li')!;
    const message = within(debugStrip()).getByText('w1').closest('li')!;
    expect(within(error).getByText('error')).toBeInTheDocument();
    expect(within(message).queryByText('error')).not.toBeInTheDocument();
  });

  // A test runs beside the flow at work, and both print into the one strip. A test's lines say so,
  // before the node that printed them, so the two can be told apart.
  it('marks the lines a test printed', async () => {
    keeping([watch]);
    render(<FlowsPage />);
    await screen.findByText('Boiler watch', { selector: 'h3' });

    act(() => useFlowStatusStore.getState().addDebug([printed('watch', 'w1'), printed('watch', 't1', { test: true })], 0));

    const fromTest = within(debugStrip()).getByText('t1').closest('li')!;
    const atWork = within(debugStrip()).getByText('w1').closest('li')!;
    const mark = within(fromTest).getByText('test');
    expect(mark).toHaveAttribute('title', 'From a test run');
    expect(mark.nextElementSibling).toHaveTextContent('MQTT in');
    expect(within(atWork).queryByText('test')).not.toBeInTheDocument();
  });

  // Clear goes with the lines it cleared, and a browser hands the keyboard of a button taken out
  // to the body. The strip's own fold stays, so the reader stays in the strip.
  it('hands the keyboard to its fold when Clear takes itself away', async () => {
    keeping([watch]);
    render(<FlowsPage />);
    await screen.findByText('Boiler watch', { selector: 'h3' });
    act(() => useFlowStatusStore.getState().addDebug([printed('watch', 'w1')], 0));

    await userEvent.click(within(debugStrip()).getByRole('button', { name: 'Clear' }));

    expect(within(debugStrip()).queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(within(debugStrip()).getByRole('button', { name: /Debug/ }));
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
    expect(await screen.findByText('500 read')).toBeInTheDocument();

    answer.release();
    await waitFor(() => expect(answered).toBe(true));
    await turns();

    expect(screen.getByText('500 read')).toBeInTheDocument();
    expect(screen.queryByText('412 read')).not.toBeInTheDocument();
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

    expect(useFlowStatusStore.getState().runs).toEqual({});
  });
});

describe('saving', () => {
  // A draft that says what the server already has is no change, however it came to be there.
  it('offers nothing to save for a draft that says what the server has', async () => {
    keeping([watch]);
    useFlowDraftStore.getState().edit(watch, (flow) => ({ ...flow }));
    render(<FlowsPage />);

    expect(await screen.findByRole('button', { name: 'Deactivate' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update' })).not.toBeInTheDocument();
    expect(useFlowDraftStore.getState().drafts.watch).toBeUndefined();
  });

  // A server that cannot write its file has said nothing about the flow: the draft is as good as it
  // was, and stays to be sent again.
  it('says why a save failed for a reason that is not about the flow, and keeps the draft', async () => {
    const { puts } = keeping([watch]);
    server.use(
      http.put('/api/flows/watch', async ({ request }) => {
        puts.push((await request.json()) as FlowDto);
        return couldNot('The disk is full.');
      }),
    );
    render(<FlowsPage />);
    await userEvent.type(await screen.findByLabelText('Name'), ' 2');

    await userEvent.click(screen.getByRole('button', { name: 'Update' }));

    expect(await screen.findByText('Not saved. The disk is full.')).toBeInTheDocument();
    expect(puts.map((flow) => flow.name)).toEqual(['Boiler watch 2']);
    expect(screen.getByRole('tab', { name: 'Boiler watch 2, not running, changes not saved' })).toBeInTheDocument();
  });

  // A read of the list that set off before a flow was saved answers with the flow as it was. Let in
  // after the save has written the new one, it would put the old flow back under a tab whose draft
  // has already gone.
  it('does not let a read that was already out put back the flow a save replaced', async () => {
    const kept = [watch];
    const answer = held();
    const out: string[] = [];
    let reading: ReturnType<typeof held> | null = null;
    let asked = false;
    server.use(
      http.get('/api/flows', async () => {
        const flows = kept.map((flow) => ({ ...flow }));
        const hold = reading;
        asked = hold !== null;
        if (hold) await hold.until;
        return HttpResponse.json(listOf(flows));
      }),
      http.put('/api/flows/:id', async ({ params, request }) => {
        const flow = (await request.json()) as FlowDto;
        out.push(String(params.id));
        await answer.until;
        kept[0] = flow;
        return HttpResponse.json({ flow });
      }),
    );
    useFlowDraftStore.getState().edit(watch, (flow) => ({ ...flow, name: 'Boiler watch 2' }));
    const { queryClient } = render(<FlowsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Update' }));
    // The window comes back into focus while the flow is on its way, and the list is read. On its
    // way, so after the read the save makes of its own before it sends.
    await waitFor(() => expect(out).toEqual(['watch']));
    const read = held();
    reading = read;
    act(() => void queryClient.invalidateQueries({ queryKey: queryKeys.flows }));
    await waitFor(() => expect(asked).toBe(true));

    answer.release();
    await waitFor(() => expect(useFlowDraftStore.getState().drafts.watch).toBeUndefined());
    read.release();
    await waitFor(() => expect(queryClient.getQueryState(queryKeys.flows)?.fetchStatus).toBe('idle'));
    await turns();

    expect(queryClient.getQueryData<FlowsDto>(queryKeys.flows)?.flows[0].name).toBe('Boiler watch 2');
    expect(screen.getByRole('tab', { name: 'Boiler watch 2, not running' })).toBeInTheDocument();
  });
});

describe('test and activate', () => {
  // A screen reader read the glyph out with the word: "black right-pointing triangle Test", "black
  // square Stop". The glyph is for the eye, and the button is named by its word.
  it('names Test and Stop by their words, and shows them with their glyphs', async () => {
    renderPage([watch]);

    const test = await screen.findByRole('button', { name: 'Test' });
    expect(test).toHaveTextContent('▶ Test');

    act(() => useFlowStatusStore.getState().setStatus(testRun('watch', 'running')));

    expect(screen.getByRole('button', { name: 'Stop' })).toHaveTextContent('■ Stop');
  });

  it('tests the flow as drawn, without saving it, and becomes Stop while the test runs', async () => {
    let tested: FlowDto | null = null;
    let saved = false;
    server.use(
      http.post('/api/flows/:id/test', async ({ request }) => {
        tested = (await request.json()) as FlowDto;
        return new HttpResponse(null, { status: 202 });
      }),
      http.put('/api/flows/:id', () => {
        saved = true;
        return HttpResponse.json({});
      }),
    );
    renderPage([watch]);
    await edit('watch', (flow) => ({ ...flow, name: 'Boiler watch 2' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Test' }));
    await waitFor(() => expect(tested?.name).toBe('Boiler watch 2'));
    expect(saved).toBe(false);

    act(() => useFlowStatusStore.getState().setStatus(testRun('watch', 'running')));
    expect(await screen.findByRole('button', { name: 'Stop' })).toBeInTheDocument();
  });

  it('stops the test run', async () => {
    let stopped = false;
    server.use(
      http.delete('/api/flows/:id/test', () => {
        stopped = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderPage([watch]);
    act(() => useFlowStatusStore.getState().setStatus(testRun('watch', 'running')));

    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(stopped).toBe(true));
  });

  // A test the server no longer has ended, or was stopped on another console, since the last push:
  // it is over, which is what Stop asked for.
  it('takes a test the server no longer has as stopped, not as a failure', async () => {
    let asked = false;
    server.use(
      http.delete('/api/flows/:id/test', () => {
        asked = true;
        return HttpResponse.json(
          { title: 'No such test', detail: 'There is no test of that flow running.', reason: 'testUnknown' },
          { status: 404, headers: { 'Content-Type': 'application/problem+json' } },
        );
      }),
    );
    renderPage([watch]);
    act(() => useFlowStatusStore.getState().setStatus(testRun('watch', 'running')));

    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(asked).toBe(true));
    await turns();

    expect(screen.queryByText(/did not stop/)).not.toBeInTheDocument();
  });

  it('says a test that did not stop, and why', async () => {
    server.use(http.delete('/api/flows/:id/test', () => couldNot('The server is starting.', 503)));
    renderPage([watch]);
    act(() => useFlowStatusStore.getState().setStatus(testRun('watch', 'running')));

    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));

    const said = 'The test did not stop. The server is starting.';
    expect(await screen.findByText(said)).toBeInTheDocument();
    expect(outcome(said)).not.toBeNull();
    // Nothing was stopped, so Stop can be pressed again.
    expect(screen.getByRole('button', { name: 'Stop' })).not.toHaveAttribute('aria-disabled');
  });

  /**
   * The server's tests of the watch, as the real one keeps them: a test it is sent runs, and answers
   * 202; one it is asked to stop is stopped and kept, counters and all, while it is going, and taken
   * away once it is not, and either answers 204; with none, it answers 404. The console hears of it
   * only when `push` says what the server has, as the hub does four times a second.
   */
  function testsOfTheWatch() {
    let test: FlowRunStatusDto | null = null;
    const sent = { tests: 0, stops: 0 };
    const going = () =>
      runOf('watch', { kind: 'test', state: 'running', nodes: [{ id: 'in', count: 3, outs: { out: 3 }, errors: 0, note: null, standing: [] }] });

    server.use(
      http.post('/api/flows/:id/test', () => {
        sent.tests++;
        test = going();
        return new HttpResponse(null, { status: 202 });
      }),
      http.delete('/api/flows/:id/test', () => {
        sent.stops++;
        if (test === null)
          return HttpResponse.json(
            { title: 'No such test', detail: 'There is no test of that flow.', reason: 'testUnknown' },
            { status: 404, headers: { 'Content-Type': 'application/problem+json' } },
          );
        test = test.state === 'running' || test.state === 'waiting' ? { ...test, state: 'stopped' } : null;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    return {
      sent,
      /** A test of the watch going on the server already, the page told of it. */
      going: () => {
        test = going();
        act(() => useFlowStatusStore.getState().setStatus({ runs: [test!] }));
      },
      push: () => act(() => useFlowStatusStore.getState().setStatus({ runs: test ? [test] : [] })),
    };
  }

  // The server stops a test that is going and keeps it, and throws one that is not going away: a
  // second press after the first had stopped it took "Test · stopped" and its counters with it.
  it('sends one stop for a double click of Stop', async () => {
    const server = testsOfTheWatch();
    renderPage([{ ...watch, enabled: false }]);
    await screen.findByRole('tabpanel');
    server.going();

    const stop = screen.getByRole('button', { name: 'Stop' });
    fireEvent.click(stop);
    fireEvent.click(stop);
    await waitFor(() => expect(server.sent.stops).toBe(1));
    await turns();

    expect(server.sent.stops).toBe(1);
  });

  it('keeps a stopped test, its counters and Test on screen when Stop was pressed twice, with no active run', async () => {
    const server = testsOfTheWatch();
    renderPage([{ ...watch, enabled: false }]);
    await screen.findByRole('tabpanel');
    server.going();

    const stop = screen.getByRole('button', { name: 'Stop' });
    fireEvent.click(stop);
    fireEvent.click(stop);
    await waitFor(() => expect(server.sent.stops).toBeGreaterThan(0));
    await turns();
    server.push();

    expect(screen.getByText('Test · stopped')).toBeInTheDocument();
    expect(screen.getByText('3 read')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test' })).not.toHaveAttribute('aria-disabled');
  });

  // The server has stopped the test, and no push has said so yet: Stop is still on screen, and is not
  // to be pressed. It goes once the push says the test has stopped, and Test is there to press.
  it('sends nothing for Stop pressed between the answer and the push that says the test stopped, and frees it after', async () => {
    const server = testsOfTheWatch();
    renderPage([{ ...watch, enabled: false }]);
    await screen.findByRole('tabpanel');
    server.going();

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(server.sent.stops).toBe(1));
    await turns();
    const stop = screen.getByRole('button', { name: 'Stop' });
    expect(stop).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(stop);
    await turns();
    expect(server.sent.stops).toBe(1);

    server.push();

    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test' })).not.toHaveAttribute('aria-disabled');
    expect(screen.getByText('Test · stopped')).toBeInTheDocument();
  });

  // Pressed again before a push shows the test, Test started it over, and its alarms, notices and
  // tones came again.
  it('sends nothing for a second Test pressed before the push that shows the first', async () => {
    const server = testsOfTheWatch();
    renderPage([{ ...watch, enabled: false }]);

    fireEvent.click(await screen.findByRole('button', { name: 'Test' }));
    await waitFor(() => expect(server.sent.tests).toBe(1));
    await turns();
    const test = screen.getByRole('button', { name: 'Test' });
    expect(test).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(test);
    await turns();
    expect(server.sent.tests).toBe(1);

    server.push();

    expect(screen.getByRole('button', { name: 'Stop' })).not.toHaveAttribute('aria-disabled');
  });

  // A push that never comes — the hub gone away — must not hold Stop off for good.
  it('frees Stop three seconds after the press when no push says the test stopped', async () => {
    const server = testsOfTheWatch();
    renderPage([{ ...watch, enabled: false }]);
    await screen.findByRole('tabpanel');
    server.going();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    try {
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
      await waitFor(() => expect(server.sent.stops).toBe(1));
      await turns();
      expect(screen.getByRole('button', { name: 'Stop' })).toHaveAttribute('aria-disabled', 'true');

      act(() => vi.advanceTimersByTime(3_000));

      expect(screen.getByRole('button', { name: 'Stop' })).not.toHaveAttribute('aria-disabled');
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks what the server refused in a test, and says the test did not start', async () => {
    server.use(
      http.post('/api/flows/:id/test', () =>
        HttpResponse.json({ title: 'Invalid flow', reason: 'flowInvalid', errors: { 'node:read': ['Give it a filter.'] } }, { status: 400 }),
      ),
    );
    renderPage([watch]);

    fireEvent.click(await screen.findByRole('button', { name: 'Test' }));
    expect(await screen.findByText(/so the test did not start/)).toBeInTheDocument();
    expect(useFlowDraftStore.getState().refusals.watch).toEqual({ 'node:read': ['Give it a filter.'] });
  });

  // Named as it was sent, as every line in the region is, and marked where it is wrong.
  it('says which flow a refused test was of, and marks it on the drawing', async () => {
    server.use(http.post('/api/flows/:id/test', () => refusal({ 'node:test': ['Pick a test.'] })));
    renderPage([watch]);
    await edit('watch', (flow) => ({ ...flow, name: 'Boiler watch 2' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Test' }));

    const said = 'The server refused Boiler watch 2, so the test did not start. What it refused is marked on it.';
    expect(await screen.findByText(said)).toBeInTheDocument();
    expect(outcome(said)).not.toBeNull();
    expect(screen.getByTitle('Pick a test.')).toHaveAttribute('data-problem');
  });

  // What the server refused was a drawing that is not the one running now.
  it('lets what was refused go once a test starts', async () => {
    let refuse = true;
    server.use(
      http.post('/api/flows/:id/test', () => (refuse ? refusal({ 'node:test': ['Pick a test.'] }) : new HttpResponse(null, { status: 202 }))),
    );
    renderPage([watch]);
    await edit('watch', (flow) => ({ ...flow, name: 'Boiler watch 2' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Test' }));
    await screen.findByText(/so the test did not start/);

    refuse = false;
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));

    await waitFor(() => expect(useFlowDraftStore.getState().refusals.watch).toBeUndefined());
    expect(screen.queryByText(/so the test did not start/)).not.toBeInTheDocument();
    expect(document.querySelector('[data-problem]')).toBeNull();
  });

  it('says a test that did not start for a reason that is not about the flow', async () => {
    server.use(http.post('/api/flows/:id/test', () => couldNot('The server is starting.', 503)));
    renderPage([watch]);

    fireEvent.click(await screen.findByRole('button', { name: 'Test' }));

    expect(await screen.findByText('The test did not start. The server is starting.')).toBeInTheDocument();
  });

  // Every button beside the tabs answers no press while a test start is out, as while a save is.
  it('holds every button off while a test start is out', async () => {
    const answer = held();
    server.use(
      http.post('/api/flows/:id/test', async () => {
        await answer.until;
        return new HttpResponse(null, { status: 202 });
      }),
    );
    renderPage([{ ...watch, enabled: false }]);
    await edit('watch', (flow) => ({ ...flow, name: 'Boiler watch 2' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Test' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Activate' })).toHaveAttribute('aria-disabled', 'true'));
    expect(screen.getByRole('button', { name: 'Test' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'Discard' })).toHaveAttribute('aria-disabled', 'true');
    answer.release();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Activate' })).not.toHaveAttribute('aria-disabled'));
    expect(screen.getByRole('button', { name: 'Discard' })).not.toHaveAttribute('aria-disabled');
  });

  // A Discard pressed while an Update is out would be undone by the answer: the server keeps the
  // change, and the page puts what it kept on screen. So Discard is off with the rest, the same way.
  it('holds Discard off while a save is out, where the answer would undo a press of it', async () => {
    const { kept } = keeping([watch]);
    const answer = held();
    server.use(
      http.put('/api/flows/:id', async ({ request }) => {
        const flow = (await request.json()) as FlowDto;
        await answer.until;
        kept[0] = flow;
        return HttpResponse.json({ flow });
      }),
    );
    render(<FlowsPage />);
    await userEvent.type(await screen.findByLabelText('Name'), ' 2');
    const discard = screen.getByRole('button', { name: 'Discard' });

    await userEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(discard).toHaveAttribute('aria-disabled', 'true'));
    expect(discard).toBeEnabled();
    await userEvent.click(discard);
    expect(useFlowDraftStore.getState().drafts.watch?.name).toBe('Boiler watch 2');

    answer.release();
    await waitFor(() => expect(useFlowDraftStore.getState().drafts.watch).toBeUndefined());
    expect(kept[0].name).toBe('Boiler watch 2');
  });

  it('activates a flow that is off, saving it switched on', async () => {
    const sent: FlowDto[] = [];
    server.use(
      http.put('/api/flows/:id', async ({ request }) => {
        const flow = (await request.json()) as FlowDto;
        sent.push(flow);
        return HttpResponse.json({ flow });
      }),
    );
    renderPage([{ ...watch, enabled: false }]);

    fireEvent.click(await screen.findByRole('button', { name: 'Activate' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].enabled).toBe(true);
  });

  it('offers Update and Deactivate for a flow that is on, Update only once it is changed', async () => {
    renderPage([{ ...watch, enabled: true }]);

    expect(await screen.findByRole('button', { name: 'Deactivate' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Activate' })).toBeNull();

    await edit('watch', (flow) => ({ ...flow, name: 'Boiler watch 2' }));
    expect(await screen.findByRole('button', { name: 'Update' })).toBeInTheDocument();
  });

  it('updates a flow that is on with the change, still switched on', async () => {
    const sent: FlowDto[] = [];
    server.use(
      http.put('/api/flows/:id', async ({ request }) => {
        const flow = (await request.json()) as FlowDto;
        sent.push(flow);
        return HttpResponse.json({ flow });
      }),
    );
    renderPage([watch]);
    await edit('watch', (flow) => ({ ...flow, name: 'Boiler watch 2' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Update' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ ...watch, name: 'Boiler watch 2', enabled: true });
    await waitFor(() => expect(useFlowDraftStore.getState().drafts.watch).toBeUndefined());
  });

  it("deactivates the server's copy, and leaves the draft a draft", async () => {
    const sent: FlowDto[] = [];
    server.use(
      http.put('/api/flows/:id', async ({ request }) => {
        const flow = (await request.json()) as FlowDto;
        sent.push(flow);
        return HttpResponse.json({ flow });
      }),
    );
    renderPage([{ ...watch, enabled: true }]);
    await edit('watch', (flow) => ({ ...flow, name: 'Boiler watch 2' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ ...watch, enabled: false });
    expect(useFlowDraftStore.getState().drafts.watch.name).toBe('Boiler watch 2');
  });

  // Another console saved the flow since this page last read it. What goes back switched off is
  // what the server has now, read just before: the copy this page read last would put that
  // console's work back the way it was.
  it('deactivates the copy the server has now, not the one this page read before', async () => {
    const v2: FlowDto = { ...watch, name: 'Boiler watch, from another console' };
    const sent: FlowDto[] = [];
    server.use(
      http.put('/api/flows/:id', async ({ request }) => {
        const flow = (await request.json()) as FlowDto;
        sent.push(flow);
        return HttpResponse.json({ flow });
      }),
    );
    renderPage([watch]);
    await screen.findByRole('button', { name: 'Deactivate' });

    // Another console saves the watch, and this page is not told.
    served = [v2];
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ ...v2, enabled: false });
  });

  // Deactivate sends the server's copy, not the drawing, so what the server refuses of it is not
  // about the drawing either: it is not marked there.
  it('says a Deactivate the server refused, without marking the drawing', async () => {
    server.use(http.put('/api/flows/:id', () => refusal({ 'node:test': ['Pick a test.'] })));
    renderPage([watch]);
    await edit('watch', (flow) => ({ ...flow, name: 'Boiler watch 2' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Deactivate' }));

    expect(await screen.findByText('Not switched off. Pick a test.')).toBeInTheDocument();
    expect(useFlowDraftStore.getState().refusals.watch).toBeUndefined();
    expect(document.querySelector('[data-problem]')).toBeNull();
  });

  // What did not happen is the flow stopping: "not saved" would leave the reader to wonder whether
  // the flow is still running, which it is.
  it('says a Deactivate that failed in the words of the button', async () => {
    server.use(http.put('/api/flows/:id', () => couldNot('The disk is full.')));
    renderPage([watch]);

    fireEvent.click(await screen.findByRole('button', { name: 'Deactivate' }));

    const said = 'Not switched off. The disk is full.';
    expect(await screen.findByText(said)).toBeInTheDocument();
    expect(outcome(said)).not.toBeNull();
  });

  /*
   * A refusal is about the draft that was sent. One let go while the request was out has nothing
   * left for the answer to mark: marked on the server's copy, which the page shows in its place, it
   * would say the server refused a flow nobody sent. The Discard beside the tabs is off until the
   * answer comes, but another tab of this console can let the draft go, and so can the reader,
   * taking an edit back while a test starts.
   */

  it('marks nothing when the draft an Update sent is let go on another tab before the refusal comes', async () => {
    const answer = held();
    let reached = false;
    server.use(
      http.put('/api/flows/:id', async () => {
        reached = true;
        await answer.until;
        return refusal({ 'node:test': ['Pick a test.'] });
      }),
    );
    renderPage([watch]);
    await edit('watch', (flow) => ({ ...flow, name: 'Boiler watch 2' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Update' }));
    await waitFor(() => expect(reached).toBe(true));
    letGoOnAnotherTab('watch');
    expect(useFlowDraftStore.getState().drafts.watch).toBeUndefined();
    answer.release();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Deactivate' })).not.toHaveAttribute('aria-disabled'));
    expect(useFlowDraftStore.getState().refusals.watch).toBeUndefined();
    expect(screen.queryByText(/^The server refused/)).not.toBeInTheDocument();
    expect(document.querySelector('[data-problem]')).toBeNull();
  });

  it('marks nothing when the draft a test sent is taken back before the refusal comes', async () => {
    const answer = held();
    let reached = false;
    server.use(
      http.post('/api/flows/:id/test', async () => {
        reached = true;
        await answer.until;
        return refusal({ 'node:test': ['Pick a test.'] });
      }),
    );
    renderPage([watch]);
    await edit('watch', (flow) => ({ ...flow, name: 'Boiler watch 2' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Test' }));
    await waitFor(() => expect(reached).toBe(true));
    await userEvent.type(screen.getByLabelText('Name'), '{Backspace}{Backspace}');
    expect(useFlowDraftStore.getState().drafts.watch).toBeUndefined();
    answer.release();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Test' })).not.toHaveAttribute('aria-disabled'));
    expect(useFlowDraftStore.getState().refusals.watch).toBeUndefined();
    expect(screen.queryByText(/^The server refused/)).not.toBeInTheDocument();
    expect(document.querySelector('[data-problem]')).toBeNull();
  });

  // jsdom lays nothing out, so this reads the rule: in a browser, a toolbar short of room shrank
  // ▶ Test — the one label with a space in it — onto two lines, half again as tall as the buttons
  // beside it. The tab row is what gives way, and it scrolls.
  it('keeps each button beside the tabs on one line, at its own size', () => {
    expect(ruleOf(toolbarSheet, '.toolbar > button')).toMatch(/flex: none/);
    expect(ruleOf(toolbarSheet, '.toolbar > button')).toMatch(/white-space: nowrap/);
  });

  it('has no Deploy button any more', async () => {
    renderPage([watch]);

    await screen.findByRole('button', { name: 'Test' });
    expect(screen.queryByRole('button', { name: /Deploy/ })).toBeNull();
  });
});

/**
 * A test can go on of a flow this page has no tab for: a draft this browser did not keep, and lost
 * with a reload; a flow another console deleted before this one read the list again; a draft of
 * another console's. With no tab there is no Stop on the toolbar, and its Sound and Notify reach every
 * console. So the page lists each one going, with a Stop of its own.
 */
describe('tests of flows the page does not have', () => {
  const strays = () => screen.queryByRole('region', { name: 'Tests with no tab' });
  const testOf = (flowId: string, state: FlowRunStatusDto['state'] = 'running') => runOf(flowId, { kind: 'test', state });

  it('lists a test going of a flow neither on the server nor drafted here, with a Stop that stops it', async () => {
    let stopped: string | null = null;
    server.use(
      http.delete('/api/flows/:id/test', ({ params }) => {
        stopped = String(params.id);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderPage([watch]);
    await screen.findByRole('tabpanel');

    act(() => useFlowStatusStore.getState().setStatus({ runs: [testOf('flost1')] }));

    const list = await screen.findByRole('region', { name: 'Tests with no tab' });
    expect(within(list).getByText('flost1')).toBeInTheDocument();
    // Out of the region the page says its lines in: the numbers bring this list, and a draft tested on
    // another console would be read out with every push.
    expect(list.closest('[aria-live]')).toBeNull();

    await userEvent.click(within(list).getByRole('button', { name: 'Stop the test of flost1' }));
    await waitFor(() => expect(stopped).toBe('flost1'));
    expect(within(list).getByRole('button', { name: 'Stop the test of flost1' })).toHaveAttribute('aria-disabled', 'true');

    act(() => useFlowStatusStore.getState().setStatus({ runs: [testOf('flost1', 'stopped')] }));
    expect(strays()).toBeNull();
  });

  it('lists one on the empty page as well', async () => {
    keeping();
    render(<FlowsPage />);
    await screen.findByRole('button', { name: 'Start from an example' });

    act(() => useFlowStatusStore.getState().setStatus({ runs: [testOf('flost1', 'waiting')] }));

    expect(within(await screen.findByRole('region', { name: 'Tests with no tab' })).getByText('flost1')).toBeInTheDocument();
  });

  it('lists no test of a flow the page has, the server\'s or a draft\'s, none that has ended, and no run that is not a test', async () => {
    renderPage([watch]);
    await screen.findByRole('tabpanel');
    act(() => useFlowDraftStore.getState().put({ ...emptyFlow('Fresh'), id: 'fresh' }));

    act(() =>
      useFlowStatusStore.getState().setStatus({
        runs: [testOf('watch'), testOf('fresh'), testOf('ended', 'finished'), testOf('halted', 'stopped'), runOf('worker')],
      }),
    );

    expect(screen.getByRole('tab', { name: /^Fresh/ })).toBeInTheDocument();
    expect(strays()).toBeNull();
  });
});

/**
 * The spec's limits are two hundred nodes to a flow and pushes up to four times a second. A push
 * that moved nothing on screen draws nothing, and a drag that moves one flow's node checks that one
 * flow for changes, not every draft there is.
 */
describe('at the limits', () => {
  const both = (count: number): FlowStatusDto => ({
    runs: [watchRun({
      nodes: [
        { id: 'in', count, outs: { out: count }, errors: 0, note: null, standing: [] },
        { id: 'test', count, outs: { yes: 3, no: count - 3 }, errors: 0, note: null, standing: [] },
      ],
    })],
  });

  it('draws nothing again for a push that moved nothing', async () => {
    keeping([watch]);
    server.use(http.get('/api/flows/status', () => HttpResponse.json(both(412))));
    const commits = vi.fn();
    render(
      <Profiler id="page" onRender={commits}>
        <FlowsPage />
      </Profiler>,
    );
    await screen.findByText('412 read');
    await turns();
    commits.mockClear();

    act(() => useFlowStatusStore.getState().setStatus(both(412)));
    await turns();
    const again = commits.mock.calls.length;

    act(() => useFlowStatusStore.getState().setStatus(both(413)));

    expect(again).toBe(0);
    expect(screen.getByText('413 read')).toBeInTheDocument();
  });

  it('checks only the flow that changed for whether it still differs from what is running', async () => {
    const flows = ['a', 'b', 'c'].map((id) => ({ ...watch, id, name: `Flow ${id}` }));
    keeping(flows);
    for (const flow of flows) useFlowDraftStore.getState().edit(flow, (one) => ({ ...one, name: `${one.name} 2` }));
    render(<FlowsPage />);
    const changed = () => screen.getAllByRole('tab', { name: /, changes not saved$/ });
    await waitFor(() => expect(changed()).toHaveLength(3));
    const stringify = vi.spyOn(JSON, 'stringify');

    act(() => useFlowDraftStore.getState().edit(flows[0], (one) => moveNodes(one, { in: { x: 48, y: 120 } })));
    const checked = stringify.mock.calls.flatMap(([value]) => {
      const id = (value as { id?: unknown } | null)?.id;
      return typeof id === 'string' ? [id] : [];
    });
    stringify.mockRestore();

    expect(new Set(checked)).toEqual(new Set(['a']));
    expect(changed()).toHaveLength(3);
  });
});

describe('deleting a flow', () => {
  // The question is about one flow. On localhost the delete and the read after it are over well
  // inside a double-click, so a question still standing for the next flow is one click from
  // deleting a flow nobody chose.
  it('does not offer the next flow for deletion once the first is gone', async () => {
    const { deletes } = keeping([watch, sim]);
    render(<FlowsPage />);
    await screen.findByText('Boiler watch', { selector: 'h3' });

    await userEvent.click(screen.getByRole('button', { name: 'Delete flow' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete it' }));

    expect(await screen.findByText('Boiler simulator', { selector: 'h3' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete it' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete flow' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /^Boiler watch/ })).not.toBeInTheDocument();
    expect(deletes).toEqual(['watch']);
  });

  // The answer is about the flow that was deleted, whichever tab the reader has gone on to since.
  it('forgets the draft of the flow it deleted, whatever is on screen when the answer comes', async () => {
    const { kept } = keeping([watch, sim]);
    const answer = held();
    server.use(
      http.delete('/api/flows/watch', async () => {
        await answer.until;
        kept.splice(kept.findIndex((one) => one.id === 'watch'), 1);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const store = useFlowDraftStore.getState();
    store.edit(watch, (flow) => ({ ...flow, name: 'Boiler watch 2' }));
    store.edit(sim, (flow) => ({ ...flow, name: 'Boiler simulator 2' }));
    store.show('watch');
    render(<FlowsPage />);
    await screen.findByText('Boiler watch 2', { selector: 'h3' });

    await userEvent.click(screen.getByRole('button', { name: 'Delete flow' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete it' }));
    await userEvent.click(screen.getByRole('tab', { name: /^Boiler simulator 2/ }));
    answer.release();

    await waitFor(() => expect(screen.queryByRole('tab', { name: /^Boiler watch/ })).not.toBeInTheDocument());
    expect(useFlowDraftStore.getState().drafts.watch).toBeUndefined();
    expect(useFlowDraftStore.getState().drafts.sim?.name).toBe('Boiler simulator 2');
    expect(useFlowDraftStore.getState().current).toBe('sim');
    expect(screen.getByText('Boiler simulator 2', { selector: 'h3' })).toBeInTheDocument();
  });

  // Until the read after the delete comes back, a tab still standing for the flow would show the
  // flow that is gone, and could be picked.
  it('takes the flow off the page at once, without waiting for the read after the delete', async () => {
    const { kept, deletes } = keeping([watch, sim]);
    render(<FlowsPage />);
    await screen.findByText('Boiler watch', { selector: 'h3' });
    const read = held();
    server.use(
      http.get('/api/flows', async () => {
        const flows = [...kept];
        await read.until;
        return HttpResponse.json({ flows, problems: [], unreadable: false, allowWebhooks: true, alertTopicPrefix: 'mqttforge/alerts/' });
      }),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Delete flow' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete it' }));
    await waitFor(() => expect(deletes).toEqual(['watch']));

    await waitFor(() => expect(screen.queryByRole('tab', { name: /^Boiler watch/ })).not.toBeInTheDocument());
    expect(screen.getByText('Boiler simulator', { selector: 'h3' })).toBeInTheDocument();
    read.release();
  });

  // A flow the server never had can still be running there, as a test of its drawing, and once it is
  // gone from the page nothing is left to press Stop on: the delete is what stops it. The server has
  // no such flow, and says so — and whatever it says, the reader's draft goes, since nothing of the
  // reader's is on the server to keep. That answer is the one the delete expects, and the log says
  // nothing of it. Any other leaves the test, if there is one, running with no console left to stop
  // it, and the log is where that is said: under a label, as every command's verb is, with the
  // sentence in the entry's body ahead of what the server answered.
  const notStopped = 'Flow test may still run';
  const deletedHere = 'Flow 1 was deleted here, but the server did not take the delete, so a test of it may still be running there.';
  it.each<[string, (() => Response) | null, object[]]>([
    ['that it has no such flow', null, []],
    [
      'that it could not',
      () => couldNot('The disk is full.'),
      [{ kind: 'fault', verb: notStopped, body: `${deletedHere} The disk is full.` }],
    ],
    [
      'nothing at all',
      () => HttpResponse.error(),
      [{ kind: 'fault', verb: notStopped, body: expect.stringContaining(`${deletedHere} `) }],
    ],
  ])('asks the server to delete a flow it never had, and drops the flow when it answers %s', async (_, answer, logged) => {
    const { deletes } = keeping();
    if (answer)
      server.use(
        http.delete('/api/flows/:id', ({ params }) => {
          deletes.push(String(params.id));
          return answer();
        }),
      );
    render(<FlowsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'New flow' }));
    const [made] = Object.keys(useFlowDraftStore.getState().drafts);

    await userEvent.click(screen.getByRole('button', { name: 'Delete flow' }));
    expect(screen.getByText('Drop Flow 1? It was never saved.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Delete it' }));

    expect(await screen.findByRole('button', { name: 'Start from an example' })).toBeInTheDocument();
    expect(useFlowDraftStore.getState().drafts).toEqual({});
    expect(deletes).toEqual([made]);
    expect(screen.queryByText(/was not deleted/)).not.toBeInTheDocument();
    expect(useLogStore.getState().commands).toEqual(logged.map((entry) => expect.objectContaining(entry)));
  });

  /*
   * The flow on screen deleted on another console, and the page shows the first flow in its place.
   * Flows share ids — the examples' wires are e1 to e7 in both, and every flow has a start and an
   * end — so a pick kept from the flow that went would pick the same id in this one: a wire the
   * palette would put its next node on, a node the inspector would open.
   */

  it('lets go of the wire picked in a flow deleted elsewhere, when the page shows another in its place', async () => {
    const { kept } = keeping([watch, sim]);
    useFlowDraftStore.getState().show('sim');
    const { queryClient } = render(<FlowsPage />);
    fireEvent.click(await screen.findByLabelText('Wait to For, next'));
    expect(useFlowDraftStore.getState().wire).toBe('e3');

    kept.splice(1, 1);
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.flows }));
    await turns();

    expect(screen.getByText('Boiler watch', { selector: 'h3' })).toBeInTheDocument();
    expect(useFlowDraftStore.getState()).toMatchObject({ current: 'watch', selected: null, wire: null });
    expect(document.querySelector('#flow-canvas .react-flow__edge-path[data-selected]')).toBeNull();
  });

  it('lets go of the node picked in a flow deleted elsewhere, when the page shows another in its place', async () => {
    const { kept } = keeping([watch, sim]);
    useFlowDraftStore.getState().show('sim');
    const { queryClient } = render(<FlowsPage />);
    const end = '#flow-canvas .react-flow__node[data-id="end"]';
    await waitFor(() => expect(document.querySelector(end)).not.toBeNull());
    fireEvent.click(document.querySelector<HTMLElement>(end)!);
    expect(useFlowDraftStore.getState().selected).toBe('end');

    kept.splice(1, 1);
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.flows }));
    await turns();

    expect(screen.getByText('Boiler watch', { selector: 'h3' })).toBeInTheDocument();
    expect(useFlowDraftStore.getState()).toMatchObject({ current: 'watch', selected: null, wire: null });
    expect(document.querySelector('#flow-canvas [data-selected]')).toBeNull();
  });

  // Deleted on another console since this one last read the list. The server answers that it has
  // no such flow, and the flow is gone either way, which is what the reader asked for.
  it('counts a flow the server no longer has as deleted, rather than saying it was not', async () => {
    const { kept, deletes } = keeping([watch, sim]);
    useFlowDraftStore.getState().edit(watch, (flow) => ({ ...flow, name: 'Boiler watch 2' }));
    useFlowDraftStore.getState().show('watch');
    render(<FlowsPage />);
    await screen.findByText('Boiler watch 2', { selector: 'h3' });
    kept.splice(0, 1);

    await userEvent.click(screen.getByRole('button', { name: 'Delete flow' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete it' }));

    expect(await screen.findByText('Boiler simulator', { selector: 'h3' })).toBeInTheDocument();
    expect(screen.queryByText(/was not deleted/)).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /^Boiler watch/ })).not.toBeInTheDocument();
    expect(useFlowDraftStore.getState().drafts.watch).toBeUndefined();
    expect(deletes).toEqual(['watch']);
  });
});

/**
 * A flow a newer build wrote, with a node this one does not know. The server keeps such a flow and
 * hands it back, refusing to run it, and says what it refused: the node, and every wire to or from
 * it, since a type it does not know has no ports it could check.
 */
describe('a node this build does not know', () => {
  const odd: FlowDto = {
    id: 'odd',
    name: 'From a newer build',
    enabled: true,
    nodes: [
      { id: 'in', type: 'mqttIn', x: 40, y: 120, config: { filter: 'plant/+/temp', replay: false } },
      { id: 'fn', type: 'function', x: 300, y: 120, config: { code: 'return msg;' } },
      { id: 'print', type: 'debug', x: 560, y: 120, config: {} },
    ],
    edges: [
      { id: 'e1', from: 'in', fromPort: 'out', to: 'fn', toPort: 'in' },
      { id: 'e2', from: 'fn', fromPort: 'out', to: 'print', toPort: 'in' },
    ],
    variables: [],
  };

  const refused: Partial<FlowsDto> = {
    problems: [
      { flowId: 'odd', key: 'node:fn', message: "This build does not know a node called 'function'." },
      { flowId: 'odd', key: 'edge:e1', message: "That node has no input called 'in'." },
      { flowId: 'odd', key: 'edge:e2', message: "This node has no output called 'out'." },
    ],
  };

  /** A node on the canvas, by the name it is drawn with. */
  const drawn = async (name: string) => {
    await screen.findByRole('tabpanel');
    return (await within(document.getElementById('flow-canvas')!).findByText(name)).closest<HTMLElement>('.react-flow__node')!;
  };

  it('opens the flow, draws the node by its type, and lets the flow be deleted', async () => {
    const { deletes } = keeping([odd], refused);
    render(<FlowsPage />);

    const node = await drawn('function');
    expect(within(node).getByTitle("This build does not know a node called 'function'.")).toHaveAttribute('data-problem');

    await userEvent.click(screen.getByRole('button', { name: 'Delete flow' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete it' }));

    expect(await screen.findByRole('button', { name: 'Start from an example' })).toBeInTheDocument();
    expect(deletes).toEqual(['odd']);
  });

  // The wires are marked red on the canvas, and this is where the reader learns why.
  it('lists each refused wire in the flow pane, by its ends and with the reason', async () => {
    keeping([odd], refused);
    render(<FlowsPage />);
    const pane = await screen.findByRole('complementary', { name: 'Inspector' });

    expect(
      await within(pane).findByText("MQTT in (plant/+/temp) → function (not known to this build): That node has no input called 'in'."),
    ).toBeInTheDocument();
    expect(
      within(pane).getByText("function (not known to this build) → Debug (prints to Debug): This node has no output called 'out'."),
    ).toBeInTheDocument();
  });

  it('says in the node pane that it does not know the node, and still takes it out', async () => {
    keeping([odd], refused);
    render(<FlowsPage />);

    fireEvent.click(await drawn('function'));

    const pane = screen.getByRole('complementary', { name: 'Inspector' });
    expect(within(pane).getByRole('heading', { name: 'function' })).toBeInTheDocument();
    expect(within(pane).getByText(/^This build does not know this kind of node\./)).toBeInTheDocument();

    await userEvent.click(within(pane).getByRole('button', { name: 'Remove node' }));

    expect(useFlowDraftStore.getState().drafts.odd.nodes.map((node) => node.id)).toEqual(['in', 'print']);
    expect(useFlowDraftStore.getState().drafts.odd.edges).toEqual([]);
  });

  it('names the node in the debug strip by its type', async () => {
    keeping([odd], refused);
    render(<FlowsPage />);
    await drawn('function');

    act(() => useFlowStatusStore.getState().addDebug([{ flowId: 'odd', nodeId: 'fn', at: '2026-09-26T09:14:22Z', kind: 'error', topic: '', text: 'It stopped.', test: false }], 0));

    const line = within(screen.getByRole('region', { name: 'Debug' })).getByText('It stopped.').closest('li')!;
    expect(within(line).getByText('function')).toBeInTheDocument();
  });
});

/**
 * Two consoles editing two different flows must not undo each other's work. A draft that holds
 * nothing of the reader's goes; one started from a copy the server has since replaced or deleted
 * is not saved over the newer copy unless the reader says so.
 */
describe('a draft and the server\'s copy', () => {
  /** The watch as another console saved it: the If now asks for more than 95. */
  const v2: FlowDto = {
    ...watch,
    nodes: watch.nodes.map((node) => (node.id === 'test' ? { ...node, config: { ...node.config, value: '95' } } : node)),
  };

  // The reviewer's sequence: a letter typed and taken back left a draft of v1 behind, which hid
  // another console's v2, and went out with the next save of an unrelated flow.
  it('keeps no draft of an edit taken back, so another console\'s save is neither hidden nor undone', async () => {
    const { kept, puts } = keeping([watch]);
    const { queryClient } = render(<FlowsPage />);
    const name = await screen.findByLabelText('Name');

    await userEvent.type(name, 'x');
    await userEvent.type(name, '{Backspace}');
    expect(screen.getByRole('tab', { name: 'Boiler watch, not running' })).toBeInTheDocument();
    expect(localStorage.getItem(DRAFT_PREFIX + 'watch')).toBeNull();

    await elsewhere(queryClient, () => (kept[0] = v2));
    expect(await screen.findByText('$.temp > 95')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Boiler watch, not running' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'New flow' }));
    await userEvent.click(screen.getByRole('button', { name: 'Activate' }));

    await waitFor(() => expect(puts.map((flow) => flow.name)).toEqual(['Flow 1']));
    expect(kept.find((flow) => flow.id === 'watch')).toEqual(v2);
  });

  it('drops a draft that is back to what is running however it got there, and leaves the pick alone', async () => {
    keeping([watch]);
    render(<FlowsPage />);
    const name = await screen.findByLabelText('Name');

    await userEvent.type(name, 'x');
    await userEvent.type(name, '{Backspace}');
    expect(useFlowDraftStore.getState().drafts.watch).toBeUndefined();

    act(() => useFlowDraftStore.getState().select('test'));
    act(() => useFlowDraftStore.getState().edit(watch, (flow) => moveNodes(flow, { test: { x: 548, y: 120 } })));
    expect(screen.getByRole('tab', { name: 'Boiler watch, not running, changes not saved' })).toBeInTheDocument();
    act(() => useFlowDraftStore.getState().edit(watch, (flow) => moveNodes(flow, { test: { x: 500, y: 120 } })));

    expect(useFlowDraftStore.getState().drafts.watch).toBeUndefined();
    expect(screen.getByRole('tab', { name: 'Boiler watch, not running' })).toBeInTheDocument();
    expect(useFlowDraftStore.getState().selected).toBe('test');
    expect(screen.getByRole('heading', { name: 'If' })).toBeInTheDocument();
  });

  // Switched off on another console, the copy is still the one the draft was started from: nothing
  // on it is what the draft changes, so the draft stands as it stood, and Activate is what is offered.
  it('leaves a draft standing as it stood when another console switches the flow off', async () => {
    const { kept, puts } = keeping([watch]);
    const { queryClient } = render(<FlowsPage />);
    await userEvent.type(await screen.findByLabelText('Name'), ' 2');

    await elsewhere(queryClient, () => (kept[0] = { ...watch, enabled: false }));

    expect(screen.getByRole('tab', { name: 'Boiler watch 2, not running, changes not saved' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Activate' }));

    await waitFor(() => expect(puts).toEqual([{ ...watch, name: 'Boiler watch 2', enabled: true }]));
  });

  it('holds back an edit of a copy another console has since replaced, until the reader keeps it', async () => {
    const { kept, puts } = keeping([watch]);
    const { queryClient } = render(<FlowsPage />);
    await userEvent.type(await screen.findByLabelText('Name'), ' 2');

    await elsewhere(queryClient, () => (kept[0] = v2));

    expect(
      await screen.findByRole('tab', { name: 'Boiler watch 2, not running, changed on the server since you started' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/^Changed on the server since you started/)).toBeInTheDocument();
    const update = () => screen.getByRole('button', { name: 'Update' });
    expect(update()).toHaveAttribute('aria-disabled', 'true');
    expect(update()).toHaveAttribute('title', expect.stringMatching(/^Changed on the server since you started/));
    await userEvent.click(update());
    await turns();
    expect(puts).toEqual([]);

    // Kept, it is an ordinary change, and Update saves it.
    await userEvent.click(screen.getByRole('button', { name: 'Keep mine' }));
    expect(screen.getByRole('tab', { name: 'Boiler watch 2, not running, changes not saved' })).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole('tab', { selected: true }));
    expect(update()).not.toHaveAttribute('aria-disabled');
    await userEvent.click(update());

    await waitFor(() => expect(puts.map((flow) => flow.name)).toEqual(['Boiler watch 2']));
  });

  // One question and one pair of answers: the pane says why the draft is held back, and Keep mine
  // and Discard stand under that sentence, where the reader is looking when they choose.
  it('offers one Discard for a draft held back, beside Keep mine in its pane', async () => {
    const { kept } = keeping([watch]);
    const { queryClient } = render(<FlowsPage />);
    await userEvent.type(await screen.findByLabelText('Name'), ' 2');
    await elsewhere(queryClient, () => (kept[0] = v2));
    await screen.findByText(/^Changed on the server since you started/);

    const discards = screen.getAllByRole('button', { name: 'Discard' });
    const pane = screen.getByRole('complementary', { name: 'Inspector' });
    expect(discards).toHaveLength(1);
    expect(within(pane).getByRole('button', { name: 'Discard' })).toBe(discards[0]);
  });

  it('puts the server\'s newer copy on screen when the reader discards theirs', async () => {
    const { kept } = keeping([watch]);
    const { queryClient } = render(<FlowsPage />);
    await userEvent.type(await screen.findByLabelText('Name'), ' 2');
    await elsewhere(queryClient, () => (kept[0] = v2));

    const pane = screen.getByRole('complementary', { name: 'Inspector' });
    await userEvent.click(await within(pane).findByRole('button', { name: 'Discard' }));

    expect(screen.getByText('$.temp > 95')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Boiler watch, not running' })).toBeInTheDocument();
    expect(useFlowDraftStore.getState().drafts.watch).toBeUndefined();
    expect(document.activeElement).toBe(screen.getByRole('tab', { selected: true }));
  });

  it('drops a draft taken back to the copy it started from, once the server has moved on from that copy', async () => {
    const { kept } = keeping([watch]);
    const { queryClient } = render(<FlowsPage />);
    const name = await screen.findByLabelText('Name');
    await userEvent.type(name, ' 2');
    await elsewhere(queryClient, () => (kept[0] = v2));
    await screen.findByText(/^Changed on the server since you started/);

    await userEvent.type(name, '{Backspace}{Backspace}');

    expect(useFlowDraftStore.getState().drafts.watch).toBeUndefined();
    expect(screen.getByText('$.temp > 95')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Boiler watch, not running' })).toBeInTheDocument();
  });

  // A flow deleted on another console must not come back as a new one with the next Activate.
  it('holds back an edit of a flow another console has since deleted, and saves it again only when kept', async () => {
    const { kept, puts } = keeping([watch, sim]);
    // On the watch's tab, as a reader who picked it is. With no flow picked the page shows the
    // first, and a flow the server no longer has goes to the end of the row.
    useFlowDraftStore.getState().show('watch');
    const { queryClient } = render(<FlowsPage />);
    await userEvent.type(await screen.findByLabelText('Name'), ' 2');

    await elsewhere(queryClient, () => kept.splice(0, 1));

    expect(
      await screen.findByRole('tab', { name: 'Boiler watch 2, not running, deleted on the server since you started' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/^Deleted on the server since you started/)).toBeInTheDocument();
    // The pane's line agrees with its box: the server had the flow, and has not now.
    expect(screen.getByText('Not on the server')).toBeInTheDocument();
    const activate = () => screen.getByRole('button', { name: 'Activate' });
    expect(activate()).toHaveAttribute('aria-disabled', 'true');
    expect(activate()).toHaveAttribute('title', expect.stringMatching(/^Deleted on the server since you started/));

    await userEvent.click(screen.getByRole('button', { name: 'Keep mine' }));
    expect(screen.getByRole('tab', { name: 'Boiler watch 2, not running, not saved' })).toBeInTheDocument();
    // Kept, it is a flow to be saved again, as one never saved is.
    expect(screen.getByText('Not saved yet')).toBeInTheDocument();
    await userEvent.click(activate());

    await waitFor(() => expect(puts.map((flow) => flow.name)).toEqual(['Boiler watch 2']));
  });

  it('lets an edit of a flow deleted elsewhere go on Discard, and the flow with it', async () => {
    const { kept } = keeping([watch, sim]);
    useFlowDraftStore.getState().show('watch');
    const { queryClient } = render(<FlowsPage />);
    await userEvent.type(await screen.findByLabelText('Name'), ' 2');
    await elsewhere(queryClient, () => kept.splice(0, 1));

    // The pane's: the toolbar's Discard is for going back to a flow the server has.
    await userEvent.click(await screen.findByRole('button', { name: 'Discard' }));

    expect(screen.queryByRole('tab', { name: /^Boiler watch/ })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^Boiler simulator/, selected: true })).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole('tab', { selected: true }));
  });

  it('drops a draft of a flow deleted elsewhere that holds nothing of the reader\'s', async () => {
    const { kept } = keeping([watch, sim]);
    useFlowDraftStore.getState().show('watch');
    const { queryClient } = render(<FlowsPage />);
    const name = await screen.findByLabelText('Name');
    await userEvent.type(name, ' 2');
    await elsewhere(queryClient, () => kept.splice(0, 1));
    await screen.findByText(/^Deleted on the server since you started/);

    await userEvent.type(name, '{Backspace}{Backspace}');

    expect(useFlowDraftStore.getState().drafts.watch).toBeUndefined();
    expect(screen.queryByRole('tab', { name: /^Boiler watch/ })).not.toBeInTheDocument();
  });

  /*
   * Two consoles side by side on two screens: neither is ever brought back into focus, and neither
   * hears the other save, so the list the page read last is all it knows. Activate and Update read
   * the list themselves before they send anything.
   */

  it('reads the list before it sends, and holds back a draft another console has overtaken since', async () => {
    const { kept, puts, reads } = keeping([watch]);
    render(<FlowsPage />);
    await userEvent.type(await screen.findByLabelText('Name'), ' 2');
    const before = reads();

    // Another console saves the watch, and this one is not told.
    kept[0] = v2;
    await userEvent.click(screen.getByRole('button', { name: 'Update' }));

    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    expect(puts).toEqual([]);
    expect(
      await screen.findByRole('tab', { name: 'Boiler watch 2, not running, changed on the server since you started' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/^Changed on the server since you started/)).toBeInTheDocument();
    expect(puts).toEqual([]);
    expect(kept[0]).toEqual(v2);
  });

  it('brings back no flow another console has deleted since, however the page last saw it', async () => {
    const { kept, puts, reads } = keeping([watch, sim]);
    useFlowDraftStore.getState().show('watch');
    render(<FlowsPage />);
    await userEvent.type(await screen.findByLabelText('Name'), ' 2');
    const before = reads();

    kept.splice(0, 1);
    await userEvent.click(screen.getByRole('button', { name: 'Update' }));

    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    expect(puts).toEqual([]);
    expect(
      await screen.findByRole('tab', { name: 'Boiler watch 2, not running, deleted on the server since you started' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Boiler watch 2 was deleted on another console since you started, so your changes were held back. Keep yours or discard them in the flow’s pane.',
      ),
    ).toBeInTheDocument();
    expect(kept.map((flow) => flow.id)).toEqual(['sim']);
  });

  // The tab says it too, but a tab is not read out when its name changes: a reader who pressed
  // Update and heard nothing would take it that the change was saved.
  it('says a draft it holds back, naming it as it was pressed, for as long as it is held back', async () => {
    const { kept, puts } = keeping([watch]);
    render(<FlowsPage />);
    await userEvent.type(await screen.findByLabelText('Name'), ' 2');

    kept[0] = v2;
    await userEvent.click(screen.getByRole('button', { name: 'Update' }));

    const said =
      'Boiler watch 2 was changed on another console since you started, so your changes were held back. Keep yours or discard them in the flow’s pane.';
    expect(await screen.findByText(said)).toBeInTheDocument();
    expect(outcome(said)).not.toBeNull();
    expect(puts).toEqual([]);

    // Kept over the server's copy, it is held back no longer, and the line goes with it.
    await userEvent.click(screen.getByRole('button', { name: 'Keep mine' }));
    expect(screen.queryByText(said)).not.toBeInTheDocument();
  });

  /*
   * A flow with no draft is pressed as the copy this page read: Activate of it is a drawing of that
   * copy, switched on. One the list read at the press no longer has as it was is not sent — it
   * would undo what another console saved, or bring back what it deleted — and the page says why.
   */

  it('activates nothing of a flow with no draft that another console has changed since, and says so', async () => {
    const { kept, puts } = keeping([{ ...watch, enabled: false }]);
    render(<FlowsPage />);
    await screen.findByRole('button', { name: 'Activate' });

    kept[0] = { ...v2, name: 'Boiler watch, from another console', enabled: false };
    await userEvent.click(screen.getByRole('button', { name: 'Activate' }));

    const said =
      'Boiler watch was changed on another console since this page read it, so it was not activated. What it has now is on screen.';
    expect(await screen.findByText(said)).toBeInTheDocument();
    expect(outcome(said)).not.toBeNull();
    expect(puts).toEqual([]);
    expect(screen.getByRole('tab', { name: 'Boiler watch, from another console, not running' })).toBeInTheDocument();
    expect(screen.getByText('$.temp > 95')).toBeInTheDocument();
  });

  // Switched on as well, the flow is on, and Deactivate is offered beside the tabs: the line does not
  // say it was not activated, only that what runs is not what was pressed.
  it('activates nothing of a flow with no draft that another console has changed and switched on since, and says it is on', async () => {
    const { kept, puts, reads } = keeping([{ ...watch, enabled: false }]);
    render(<FlowsPage />);
    await screen.findByRole('button', { name: 'Activate' });
    const before = reads();

    kept[0] = { ...v2, name: 'Boiler watch, from another console', enabled: true };
    await userEvent.click(screen.getByRole('button', { name: 'Activate' }));
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    await turns();

    expect(puts).toEqual([]);
    const said =
      'Boiler watch was changed on another console since this page read it, and switched on there. What it has now is on screen.';
    expect(await screen.findByText(said)).toBeInTheDocument();
    expect(outcome(said)).not.toBeNull();
    expect(screen.getByText(said)).toHaveClass(panelStyles.fault);
    expect(screen.queryByText(/not activated/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deactivate' })).toBeInTheDocument();
    expect(screen.getByText('$.temp > 95')).toBeInTheDocument();
  });

  it('brings back no flow with no draft that another console has deleted since, and says so', async () => {
    const { kept, puts, reads } = keeping([{ ...watch, enabled: false }, sim]);
    render(<FlowsPage />);
    await screen.findByRole('button', { name: 'Activate' });
    const before = reads();

    kept.splice(0, 1);
    await userEvent.click(screen.getByRole('button', { name: 'Activate' }));
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    await turns();

    expect(puts).toEqual([]);
    expect(kept.map((flow) => flow.id)).toEqual(['sim']);
    const said = 'Boiler watch was deleted on another console, so it was not activated.';
    expect(await screen.findByText(said)).toBeInTheDocument();
    expect(outcome(said)).not.toBeNull();
    expect(screen.queryByRole('tab', { name: /^Boiler watch/ })).not.toBeInTheDocument();
  });

  /*
   * Whether a flow is switched on is no part of a drawing (see canonical), so a press says what it
   * expects of it. One that finds another console has switched the flow since does not switch it
   * back over that console — an Update does not start again a flow somebody stopped — and one that
   * finds done what it asked for has nothing to send. Either way the page says so.
   */

  it('saves no change over another console\'s Deactivate, and offers Activate in its place', async () => {
    const { kept, puts, reads } = keeping([watch]);
    render(<FlowsPage />);
    await userEvent.type(await screen.findByLabelText('Name'), ' 2');
    const before = reads();

    kept[0] = { ...watch, enabled: false };
    await userEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    await turns();

    expect(puts).toEqual([]);
    const said =
      'Boiler watch 2 was switched off on another console since this page read it, so your change was not saved. Activate saves it and switches it on.';
    expect(await screen.findByText(said)).toBeInTheDocument();
    expect(outcome(said)).not.toBeNull();
    expect(screen.getByText(said)).toHaveClass(panelStyles.fault);
    expect(screen.getByRole('button', { name: 'Activate' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update' })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Boiler watch 2, not running, changes not saved' })).toBeInTheDocument();
  });

  /*
   * The line of an Update held back from a flow switched off tells the reader Activate saves the
   * change: so it stands only while there is a change to save and the flow is still off. It goes
   * once the change is let go, or another console switches the flow back on, and does not come back
   * with a change made since, or the flow switched off again: the press it was about is over.
   */

  it('stops saying Activate saves a change held back from a flow switched off once the change is discarded', async () => {
    const { kept, puts } = keeping([watch]);
    render(<FlowsPage />);
    await userEvent.type(await screen.findByLabelText('Name'), ' 2');
    kept[0] = { ...watch, enabled: false };
    await userEvent.click(screen.getByRole('button', { name: 'Update' }));
    const said =
      'Boiler watch 2 was switched off on another console since this page read it, so your change was not saved. Activate saves it and switches it on.';
    expect(await screen.findByText(said)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.queryByText(said)).not.toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Name'), ' 3');
    expect(screen.getByRole('tab', { name: 'Boiler watch 3, not running, changes not saved' })).toBeInTheDocument();
    expect(screen.queryByText(said)).not.toBeInTheDocument();
    expect(puts).toEqual([]);
  });

  it('stops saying Activate saves a change held back from a flow switched off once another console switches it back on', async () => {
    const { kept } = keeping([watch]);
    const { queryClient } = render(<FlowsPage />);
    await userEvent.type(await screen.findByLabelText('Name'), ' 2');
    kept[0] = { ...watch, enabled: false };
    await userEvent.click(screen.getByRole('button', { name: 'Update' }));
    const said =
      'Boiler watch 2 was switched off on another console since this page read it, so your change was not saved. Activate saves it and switches it on.';
    expect(await screen.findByText(said)).toBeInTheDocument();

    await elsewhere(queryClient, () => (kept[0] = watch));
    expect(screen.queryByText(said)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update' })).toBeInTheDocument();

    await elsewhere(queryClient, () => (kept[0] = { ...watch, enabled: false }));
    expect(screen.getByRole('button', { name: 'Activate' })).toBeInTheDocument();
    expect(screen.queryByText(said)).not.toBeInTheDocument();
  });

  it('sends nothing more for an Activate another console has already made, and says so', async () => {
    const { kept, puts, reads } = keeping([{ ...watch, enabled: false }]);
    render(<FlowsPage />);
    await screen.findByRole('button', { name: 'Activate' });
    const before = reads();

    kept[0] = watch;
    await userEvent.click(screen.getByRole('button', { name: 'Activate' }));
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    await turns();

    expect(puts).toEqual([]);
    const said = 'Boiler watch was already activated on another console.';
    expect(await screen.findByText(said)).toBeInTheDocument();
    expect(outcome(said)).not.toBeNull();
    // Nothing went wrong: the flow is as the reader wanted it.
    expect(screen.getByText(said)).toHaveClass(panelStyles.note);
    expect(screen.getByText(said)).not.toHaveClass(panelStyles.fault);
    expect(screen.getByRole('button', { name: 'Deactivate' })).toBeInTheDocument();
  });

  it('sends a standing draft on Activate, switched on, when another console has only switched the flow on since', async () => {
    const { kept, puts, reads } = keeping([{ ...watch, enabled: false }]);
    render(<FlowsPage />);
    await userEvent.type(await screen.findByLabelText('Name'), ' 2');
    const before = reads();

    kept[0] = watch;
    await userEvent.click(screen.getByRole('button', { name: 'Activate' }));

    await waitFor(() => expect(puts).toEqual([{ ...watch, name: 'Boiler watch 2', enabled: true }]));
    expect(reads()).toBeGreaterThan(before);
    expect(kept[0]).toEqual({ ...watch, name: 'Boiler watch 2', enabled: true });
    await waitFor(() => expect(useFlowDraftStore.getState().drafts.watch).toBeUndefined());
    expect(screen.queryByText(/another console/)).not.toBeInTheDocument();
  });

  it('sends nothing for a Deactivate another console has already made, and says so', async () => {
    const { kept, puts, reads } = keeping([watch]);
    render(<FlowsPage />);
    await screen.findByRole('button', { name: 'Deactivate' });
    const before = reads();

    kept[0] = { ...watch, enabled: false };
    await userEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    await turns();

    expect(puts).toEqual([]);
    const said = 'Boiler watch was already switched off on another console.';
    expect(await screen.findByText(said)).toBeInTheDocument();
    expect(outcome(said)).not.toBeNull();
    expect(screen.getByText(said)).not.toHaveClass(panelStyles.fault);
    expect(screen.getByRole('button', { name: 'Activate' })).toBeInTheDocument();
  });

  it('sends nothing for a Deactivate of a flow another console has deleted, and says so', async () => {
    const { kept, puts, reads } = keeping([watch, sim]);
    render(<FlowsPage />);
    await screen.findByRole('button', { name: 'Deactivate' });
    const before = reads();

    kept.splice(0, 1);
    await userEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    await turns();

    expect(puts).toEqual([]);
    const said = 'Boiler watch was deleted on another console, so there was nothing to switch off.';
    expect(await screen.findByText(said)).toBeInTheDocument();
    expect(outcome(said)).not.toBeNull();
  });

  /*
   * The flow was the only one: the list the press reads has none, and the page becomes the way to
   * start a flow. The keyboard goes to the first way to start, as it does when the last flow is
   * deleted here, and the line that says why goes into a region already in the page.
   */

  // "What it has now is on screen" is so while the server has the flow: once another console has
  // deleted it as well, the line stood on the empty page over nothing.
  it('stops saying what another console changed of a flow pressed with no draft once the flow is gone', async () => {
    const { kept } = keeping([{ ...watch, enabled: false }]);
    const { queryClient } = render(<FlowsPage />);
    await screen.findByRole('button', { name: 'Activate' });

    kept[0] = { ...v2, name: 'Boiler watch, from another console', enabled: false };
    await userEvent.click(screen.getByRole('button', { name: 'Activate' }));
    const said =
      'Boiler watch was changed on another console since this page read it, so it was not activated. What it has now is on screen.';
    expect(await screen.findByText(said)).toBeInTheDocument();

    await elsewhere(queryClient, () => kept.splice(0, 1));

    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.queryByText(said)).not.toBeInTheDocument();
  });

  // A line that went is gone for good, as the answer it was of; but the next press is another
  // answer, said whatever it says — though it say the very same thing as the one before.
  it('says a press held back again when it is pressed again, though the line of the one before went', async () => {
    const { kept } = keeping([{ ...watch, enabled: false }]);
    const { queryClient } = render(<FlowsPage />);
    await screen.findByRole('button', { name: 'Activate' });
    const said =
      'Boiler watch was changed on another console since this page read it, so it was not activated. What it has now is on screen.';

    kept[0] = { ...v2, name: 'Boiler watch, from another console', enabled: false };
    await userEvent.click(screen.getByRole('button', { name: 'Activate' }));
    expect(await screen.findByText(said)).toBeInTheDocument();
    await elsewhere(queryClient, () => kept.splice(0, 1));
    expect(screen.queryByText(said)).not.toBeInTheDocument();

    // Saved again on another console as it was first, and read here; then changed there once more.
    await elsewhere(queryClient, () => kept.push({ ...watch, enabled: false }));
    kept[0] = { ...v2, name: 'Boiler watch, from another console', enabled: false };
    await userEvent.click(await screen.findByRole('button', { name: 'Activate' }));

    expect(await screen.findByText(said)).toBeInTheDocument();
  });

  it('says on the empty page an Activate of the last flow, which another console has deleted since', async () => {
    const { kept, puts, reads } = keeping([{ ...watch, enabled: false }]);
    render(<FlowsPage />);
    const activate = await screen.findByRole('button', { name: 'Activate' });
    const before = reads();
    const heard = listen();

    kept.splice(0, 1);
    await userEvent.click(activate);
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    await turns();

    const said = 'Boiler watch was deleted on another console, so it was not activated.';
    expect(await screen.findByText(said)).toBeInTheDocument();
    expect(heard()).toContain(said);
    expect(puts).toEqual([]);
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Start from an example' }));
  });

  it('says on the empty page a Deactivate of the last flow, which another console has deleted since', async () => {
    const { kept, puts, reads } = keeping([watch]);
    render(<FlowsPage />);
    const deactivate = await screen.findByRole('button', { name: 'Deactivate' });
    const before = reads();
    const heard = listen();

    kept.splice(0, 1);
    await userEvent.click(deactivate);
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    await turns();

    const said = 'Boiler watch was deleted on another console, so there was nothing to switch off.';
    expect(await screen.findByText(said)).toBeInTheDocument();
    expect(heard()).toContain(said);
    expect(puts).toEqual([]);
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Start from an example' }));
  });

  // Without the list there is no telling whether another console has overtaken the draft, so
  // nothing goes, and the page says why rather than leaving the reader with a press that did nothing.
  it('sends nothing when the list cannot be read first, and says so', async () => {
    const { puts } = keeping([watch]);
    render(<FlowsPage />);
    await userEvent.type(await screen.findByLabelText('Name'), ' 2');
    server.use(http.get('/api/flows', () => couldNot('The server is starting.', 503)));

    await userEvent.click(screen.getByRole('button', { name: 'Update' }));

    const said = 'Not saved. The flows could not be read from the server first, so nothing was sent. The server is starting.';
    expect(await screen.findByText(said)).toBeInTheDocument();
    expect(outcome(said)).not.toBeNull();
    expect(puts).toEqual([]);
    expect(screen.getByRole('tab', { name: 'Boiler watch 2, not running, changes not saved' })).toBeInTheDocument();
  });
});

/** The answer the server gives a request it could not carry out, for a reason that is not about the flow. */
/** The line under the tabs that says what did not go through, as a screen reader is told it. */
const outcome = (text: string | RegExp) => screen.getByText(text).closest('[aria-live="polite"]');

/**
 * Listens from now on for the lines put into a polite live region that is already in the page, and
 * hands back, once, what it heard. A region that comes into the page with its words already inside
 * is not read out by every screen reader, so a line that comes in that way is not heard here either.
 */
function listen() {
  const heard: string[] = [];
  const take = (records: MutationRecord[]) => {
    for (const record of records)
      if (record.target instanceof Element && record.target.matches('[aria-live="polite"]'))
        for (const node of record.addedNodes) heard.push(node.textContent ?? '');
  };
  const observer = new MutationObserver(take);
  observer.observe(document.body, { childList: true, subtree: true });

  return () => {
    take(observer.takeRecords());
    observer.disconnect();
    return heard;
  };
}

/**
 * What the reader asked of the server that did not go through. The page covers the log, so each is
 * said under the tabs, where a save or a test that did not go through is said — and in one polite
 * live region, so a reader who cannot see the marks it leaves is told as well.
 */
/**
 * What the server refused is marked on the nodes it refused, and the line under the tabs says so.
 * A flow wider than the canvas opens at a zoom it can be read at, so most of it can be out of sight,
 * and a refusal marked only there said "marked on it" of marks nobody could see.
 */
describe('a refusal of the flow on screen', () => {
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

  /** Start, a Debug in sight beside it, and one far along the row: too wide to read fitted, so it opens from its Start. */
  const wide: FlowDto = {
    id: 'wide', name: 'Wide', enabled: false, variables: [],
    nodes: [
      { id: 'start', type: 'start', x: 0, y: 0, config: {} },
      { id: 'near', type: 'debug', x: 300, y: 0, config: {} },
      { id: 'far', type: 'debug', x: 3000, y: 0, config: {} },
      { id: 'end', type: 'end', x: 3300, y: 0, config: {} },
    ],
    edges: [
      { id: 'e1', from: 'start', fromPort: 'out', to: 'near', toPort: 'in' },
      { id: 'e2', from: 'near', fromPort: 'out', to: 'far', toPort: 'in' },
      { id: 'e3', from: 'far', fromPort: 'out', to: 'end', toPort: 'in' },
    ],
  };

  /** Whether a node of the wide flow is wholly on screen, a pixel square as jsdom measures it. */
  const seen = (id: string) => {
    const node = wide.nodes.find((one) => one.id === id)!;
    const [x, y, zoom] = viewport();
    return node.x * zoom + x >= 0 && node.y * zoom + y >= 0 && (node.x + 1) * zoom + x <= 800 && (node.y + 1) * zoom + y <= 600;
  };

  it('brings the first node it marks into view, at the zoom it had, when it marks none in sight', async () => {
    server.use(http.post('/api/flows/:id/test', () => refusal({ 'node:far': ['Pick a level.'], 'node:end': ['Not this End.'] })));
    renderPage([wide]);
    await screen.findByRole('button', { name: 'Test' });
    await waitFor(() => expect(viewport()[2]).toBe(0.6));
    expect(seen('far')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    await screen.findByText(/so the test did not start/);

    await waitFor(() => expect(seen('far')).toBe(true));
    expect(viewport()[2]).toBe(0.6);
    expect(useFlowDraftStore.getState().selected).toBeNull();
  });

  it('leaves the view alone when a node it marks is in sight', async () => {
    keeping([wide]);
    server.use(http.put('/api/flows/wide', () => refusal({ 'node:far': ['Pick a level.'], 'node:near': ['Not this Debug.'] })));
    render(<FlowsPage />);
    await screen.findByRole('button', { name: 'Activate' });
    await waitFor(() => expect(viewport()[2]).toBe(0.6));
    const opened = viewport();

    fireEvent.click(screen.getByRole('button', { name: 'Activate' }));
    await screen.findByText(/so it was not saved/);
    await turns();

    expect(viewport()).toEqual(opened);
  });
});

describe('what did not go through', () => {
  it('says a save that failed in a live region of its own, not over the whole page', async () => {
    keeping([watch]);
    server.use(http.put('/api/flows/watch', () => couldNot('The disk is full.')));
    render(<FlowsPage />);

    await userEvent.type(await screen.findByLabelText('Name'), ' 2');
    await userEvent.click(screen.getByRole('button', { name: 'Update' }));

    await screen.findByText('Not saved. The disk is full.');
    const region = outcome('Not saved. The disk is full.');
    expect(region).not.toBeNull();
    expect(region).not.toContainElement(screen.getByRole('tablist'));
    expect(region).not.toContainElement(screen.getByRole('tabpanel'));
  });

  // A refusal marks the nodes it is about, and a flow refused on another tab has only its tab's
  // lamp to show it. A screen reader was told nothing at all.
  it('says which flow the server refused, and stops once its refusal lapses', async () => {
    keeping([watch]);
    server.use(http.put('/api/flows/watch', () => refusal({ 'node:test': ['Pick a test.'] })));
    render(<FlowsPage />);
    const name = await screen.findByLabelText('Name');

    await userEvent.type(name, ' 2');
    await userEvent.click(screen.getByRole('button', { name: 'Update' }));

    const said = 'The server refused Boiler watch 2, so it was not saved. What it refused is marked on it.';
    expect(await screen.findByText(said)).toBeInTheDocument();
    expect(outcome(said)).not.toBeNull();

    // Taken back to what is running, the draft goes, and its refusal with it.
    await userEvent.type(name, '{Backspace}{Backspace}');
    expect(screen.queryByText(said)).not.toBeInTheDocument();
  });

  // A flow has one refusal at a time, the last the server gave, and the marks on its drawing are
  // that one's. Only the line of the request that filed it is said: the line of the one before
  // would say its marks are on the drawing when they are gone.
  it('says only the line of the request whose refusal stands, a test\'s or a save\'s', async () => {
    keeping([watch]);
    server.use(
      http.post('/api/flows/:id/test', () => refusal({ 'node:test': ['Pick a test.'] })),
      http.put('/api/flows/:id', () => refusal({ 'node:in': ['Give it a filter.'] })),
    );
    render(<FlowsPage />);
    await userEvent.type(await screen.findByLabelText('Name'), ' 2');
    const tested = 'The server refused Boiler watch 2, so the test did not start. What it refused is marked on it.';
    const saved = 'The server refused Boiler watch 2, so it was not saved. What it refused is marked on it.';

    await userEvent.click(screen.getByRole('button', { name: 'Test' }));
    expect(await screen.findByText(tested)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Update' }));
    expect(await screen.findByText(saved)).toBeInTheDocument();
    expect(screen.queryByText(tested)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Test' }));
    expect(await screen.findByText(tested)).toBeInTheDocument();
    expect(screen.queryByText(saved)).not.toBeInTheDocument();
  });

  // The numbers are pushed four times a second. A live region they reached would be read out on
  // every push.
  it('says nothing new when the numbers are pushed', async () => {
    keeping([watch]);
    server.use(http.put('/api/flows/watch', () => refusal({ 'node:test': ['Pick a test.'] })));
    render(<FlowsPage />);
    await userEvent.type(await screen.findByLabelText('Name'), ' 2');
    await userEvent.click(screen.getByRole('button', { name: 'Update' }));
    const region = (await screen.findByText(/^The server refused/)).closest('[aria-live="polite"]')!;

    const changes: MutationRecord[] = [];
    const watcher = new MutationObserver((records) => changes.push(...records));
    watcher.observe(region, { subtree: true, childList: true, characterData: true, attributes: true });
    act(() => useFlowStatusStore.getState().setStatus(watchHasSeen(1)));
    act(() => useFlowStatusStore.getState().setStatus(watchHasSeen(2)));
    act(() => useFlowStatusStore.getState().setStatus({ runs: [] }));
    await turns();
    watcher.disconnect();

    expect(screen.getByRole('tab', { name: /^Boiler watch 2, not running/ })).toBeInTheDocument();
    expect(changes).toEqual([]);
  });

  it('says a flow that was not deleted, and stays on Delete it to try again', async () => {
    const { kept, deletes } = keeping([watch]);
    const answer = held();
    server.use(
      http.delete('/api/flows/watch', async () => {
        deletes.push('watch');
        await answer.until;
        return couldNot('The disk is full.');
      }),
    );
    render(<FlowsPage />);
    await screen.findByText('Boiler watch', { selector: 'h3' });

    await userEvent.click(screen.getByRole('button', { name: 'Delete flow' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete it' }));
    // Off while the delete is out, but said rather than set, as Activate is: a button switched off
    // in the hand that pressed it loses the focus in some browsers.
    const deleting = screen.getByRole('button', { name: 'Delete it' });
    expect(deleting).toBeEnabled();
    expect(deleting).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(deleting);
    answer.release();

    expect(await screen.findByText('Boiler watch was not deleted. The disk is full.')).toBeInTheDocument();
    expect(outcome('Boiler watch was not deleted. The disk is full.')).not.toBeNull();
    expect(deletes).toEqual(['watch']);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Delete it' }));
    expect(screen.getByRole('button', { name: 'Delete it' })).not.toHaveAttribute('aria-disabled');

    // Tried again, the line goes with the attempt.
    server.use(
      http.delete('/api/flows/watch', () => {
        kept.splice(0, 1);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Delete it' }));
    expect(await screen.findByRole('button', { name: 'Start from an example' })).toBeInTheDocument();
    expect(screen.queryByText(/was not deleted/)).not.toBeInTheDocument();
  });

  // The line stays under the tabs whichever flow is on screen, so it says which flow it is about:
  // unnamed, a reader who had gone on to another flow read it as theirs. Named as the flow was
  // named when it failed — in a live region, a name that followed a rename would be read out again
  // with every letter.
  it('names the flow a failure is about, for a reader who has gone on to another', async () => {
    keeping([watch, sim]);
    server.use(http.delete('/api/flows/watch', () => couldNot('The disk is full.')));
    render(<FlowsPage />);
    await screen.findByText('Boiler watch', { selector: 'h3' });

    await userEvent.click(screen.getByRole('button', { name: 'Delete flow' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete it' }));
    const said = 'Boiler watch was not deleted. The disk is full.';
    expect(await screen.findByText(said)).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Name'), ' 2');
    await userEvent.click(screen.getByRole('tab', { name: /^Boiler simulator/ }));

    expect(screen.getByText('Boiler simulator', { selector: 'h3' })).toBeInTheDocument();
    expect(screen.getByText(said)).toBeInTheDocument();
  });

  // Storage full, or site data blocked: a reload would bring back an older set of drafts, or none,
  // without a word. Said once, when the first draft is refused, and not again with each keystroke.
  it('says once, not with every keystroke, that the browser will not keep the drafts', async () => {
    keeping([watch]);
    render(<FlowsPage />);
    const name = await screen.findByLabelText('Name');
    const full = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });

    await userEvent.type(name, ' 2');
    const said = /^This browser would not keep the drafts/;
    const note = screen.getByText(said);
    expect(outcome(said)).not.toBeNull();
    await userEvent.type(name, '3');
    full.mockRestore();

    expect(screen.getAllByText(said)).toEqual([note]);
    expect(screen.getByRole('tab', { name: /^Boiler watch 23/ })).toBeInTheDocument();
  });
});

/**
 * A flow alarm's row on the alarm wall opens this page, on the flow the alarm came from with its
 * Raise alarm node picked. The node's pane lists the alarms it holds up; the Alerts panel, a list of
 * rules, has nothing to say about one.
 */
describe('a flow alarm the reader asked to see', () => {
  /** The watch with a Raise alarm on its yes, and the run ending after it whether the alarm is new or up. */
  const alarmed: FlowDto = {
    ...watch,
    nodes: [
      ...watch.nodes,
      { id: 'hot', type: 'alarmRaise', x: 800, y: 0, config: { name: 'Boiler too hot', level: 'warn', reason: '{{topic}}', value: '' } },
    ],
    edges: [
      ...watch.edges.filter((edge) => edge.id !== 'e2'),
      { id: 'e4', from: 'test', fromPort: 'yes', to: 'hot', toPort: 'in' },
      { id: 'e5', from: 'hot', fromPort: 'raised', to: 'end', toPort: 'in' },
      { id: 'e6', from: 'hot', fromPort: 'up', to: 'end', toPort: 'in' },
    ],
  };
  const inspecting = () => within(screen.getByRole('complementary', { name: 'Inspector' }));

  it('opens on the flow it came from, with its Raise alarm node picked', async () => {
    keeping([sim, alarmed]);
    useFlowAlarmStore.getState().ask('flow-watch-hot');
    render(<FlowsPage />);

    expect(await screen.findByRole('tab', { name: /^Boiler watch/, selected: true })).toBeInTheDocument();
    expect(inspecting().getByRole('heading', { name: 'Raise alarm' })).toBeInTheDocument();
    expect(useFlowAlarmStore.getState().asked).toBeNull();
  });

  it('turns to it when asked with the page already open', async () => {
    keeping([sim, alarmed]);
    render(<FlowsPage />);
    await screen.findByText('Boiler simulator', { selector: 'h3' });

    act(() => useFlowAlarmStore.getState().ask('flow-watch-hot'));

    expect(screen.getByRole('tab', { name: /^Boiler watch/, selected: true })).toBeInTheDocument();
    expect(inspecting().getByRole('heading', { name: 'Raise alarm' })).toBeInTheDocument();
  });

  it('lets the question go when the flow is not there any more', async () => {
    keeping([sim]);
    useFlowAlarmStore.getState().ask('flow-watch-hot');
    render(<FlowsPage />);

    expect(await screen.findByText('Boiler simulator', { selector: 'h3' })).toBeInTheDocument();
    await waitFor(() => expect(useFlowAlarmStore.getState().asked).toBeNull());
  });

  // A test runs the drawing, and the drawing can be of a flow the server has never had — the
  // examples are only drafts until they are activated — so its alarms lead to the draft.
  it('opens on the draft a test alarm came from, though the server has never had it', async () => {
    keeping([sim]);
    useFlowDraftStore.getState().put(alarmed);
    useFlowAlarmStore.getState().ask('flowtest-watch-hot');
    render(<FlowsPage />);

    expect(await screen.findByRole('tab', { name: /^Boiler watch/, selected: true })).toBeInTheDocument();
    expect(inspecting().getByRole('heading', { name: 'Raise alarm' })).toBeInTheDocument();
    expect(useFlowAlarmStore.getState().asked).toBeNull();
  });
});

/**
 * What the server says of a running flow besides its counts: each node's last word — the value it
 * read, or what went wrong — and what stopped the flow. The page covers the log, so these are the
 * only places they are said.
 */
describe('what a running flow says', () => {
  const refusedFilter = (fault: string | null = null): FlowStatusDto => ({
    runs: [watchRun({
      fault,
      nodes: [
        { id: 'in', count: 0, outs: {}, errors: 1, note: 'The broker refused this filter.', standing: [] },
        { id: 'test', count: 0, outs: {}, errors: 0, note: null, standing: [] },
      ],
    })],
  });

  it('says why a node counts an error, on its status line and in its pane', async () => {
    keeping([watch]);
    server.use(http.get('/api/flows/status', () => HttpResponse.json(refusedFilter())));
    render(<FlowsPage />);

    const line = await screen.findByText('0 read · 1 error');
    expect(line).toHaveAttribute('title', 'The broker refused this filter.');

    fireEvent.click(line.closest<HTMLElement>('.react-flow__node')!);

    const pane = screen.getByRole('complementary', { name: 'Inspector' });
    expect(within(pane).getByText('The broker refused this filter.')).toBeInTheDocument();
  });

  it('says what stopped the flow, in its own pane', async () => {
    keeping([watch]);
    server.use(
      http.get('/api/flows/status', () => HttpResponse.json(refusedFilter('An event ran more than 10000 nodes and was stopped.'))),
    );
    render(<FlowsPage />);

    const pane = await screen.findByRole('complementary', { name: 'Inspector' });
    expect(await within(pane).findByText('An event ran more than 10000 nodes and was stopped.')).toHaveClass(panelStyles.fault);
  });

  // The pane says what stopped the run the canvas is showing: a test's fault is the test's, not the
  // flow's, and the flow's own comes back with the canvas once the test is over.
  it('says what stopped the run on show: the test while one goes, else the flow at work', async () => {
    keeping([watch]);
    render(<FlowsPage />);
    const pane = within(await screen.findByRole('complementary', { name: 'Inspector' }));
    const atWork = watchRun({ fault: 'The flow at work stopped.' });
    const test = watchRun({ kind: 'test', state: 'running', fault: 'The test stopped.' });

    act(() => useFlowStatusStore.getState().setStatus({ runs: [atWork, test] }));

    expect(pane.getByText('The test stopped.')).toHaveClass(panelStyles.fault);
    expect(pane.queryByText('The flow at work stopped.')).not.toBeInTheDocument();

    act(() => useFlowStatusStore.getState().setStatus({ runs: [atWork, { ...test, state: 'finished' }] }));

    expect(pane.getByText('The flow at work stopped.')).toHaveClass(panelStyles.fault);
    expect(pane.queryByText('The test stopped.')).not.toBeInTheDocument();
  });

  /** The watch's MQTT in, having read one message, with its last word on it. */
  const lastRead = (note: string): FlowStatusDto => ({
    runs: [watchRun({ nodes: [{ id: 'in', count: 1, outs: { out: 1 }, errors: 0, note, standing: [] }] })],
  });

  /** The pane of the watch's MQTT in, once the reader has picked it. */
  const inPane = async () => {
    fireEvent.click((await screen.findByText('1 read')).closest<HTMLElement>('.react-flow__node')!);
    return within(screen.getByRole('complementary', { name: 'Inspector' }));
  };

  // The pane has some 270 pixels across for text, and a note is up to eighty characters of JSON or
  // of a topic with no space in it to break at: it ran on past the pane's edge, and gave the pane a
  // scrollbar across.
  it('breaks a node\'s last word to the width of its pane', async () => {
    const long = '{"temp":94.2,"unit":"C","probe":"kiln-2/boiler-room/a"}';
    keeping([watch]);
    server.use(http.get('/api/flows/status', () => HttpResponse.json(lastRead(long))));
    render(<FlowsPage />);

    expect((await inPane()).getByText(long)).toHaveClass(inspector.mono);
    expect(ruleOf(inspectorSheet, '.mono')).toMatch(/overflow-wrap: anywhere/);
  });

  // A message with nothing in it is still a message. "Last:" with nothing after it reads as a pane
  // that failed to draw; the debug strip says what a message was missing in words, and so does this.
  it('says a node\'s last word was empty, rather than leaving the line bare', async () => {
    keeping([watch]);
    server.use(http.get('/api/flows/status', () => HttpResponse.json(lastRead(''))));
    render(<FlowsPage />);

    const note = (await inPane()).getByText(/^Last:/);
    expect(note).toHaveTextContent(/^Last: \(empty\)$/);
  });
});

describe('drafts kept from an earlier visit', () => {
  // What storage holds outlives the build that wrote it. A draft short of a name, kept as the
  // flow on screen, took the page down on every open, and a reload landed on it again.
  it('open the page when one of them is not a whole flow', async () => {
    keeping([watch]);
    localStorage.setItem(`${DRAFT_PREFIX}broken`, JSON.stringify({ version: 1, flow: { id: 'broken' }, base: null }));
    sessionStorage.setItem('mqttforge.flows.current', 'broken');
    vi.resetModules();
    const { default: Reopened } = await import('./FlowsPage');

    render(<Reopened />);

    expect(await screen.findByRole('tab', { name: /^Boiler watch/ })).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(1);
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
    expect(screen.getByLabelText('MQTT in to If').querySelector('[data-problem]')).not.toBeNull();
    expect(screen.getByRole('tab', { name: /Boiler watch/ })).toHaveAttribute('data-state', 'refused');
  });
});

describe('a refusal', () => {
  // A refusal is about a draft. Edited back to what is running, the flow has no draft for it to be
  // about: nothing may go on saying the server refused it of a flow with no changes, and the next
  // edit must not bring it back.
  it('lapses once the flow is back to what is running', async () => {
    keeping([watch]);
    server.use(http.put('/api/flows/watch', () => refusal({ flow: ['The flow is not right.'], 'node:test': ['Pick a test.'], 'edge:e1': ['Not this wire.'] })));
    render(<FlowsPage />);
    const name = await screen.findByLabelText('Name');

    await userEvent.type(name, ' 2');
    await userEvent.click(screen.getByRole('button', { name: 'Update' }));
    expect(await screen.findByTitle('Pick a test.')).toHaveAttribute('data-problem');
    expect(screen.getByText('The flow is not right.')).toBeInTheDocument();

    await userEvent.type(name, '{Backspace}{Backspace}');

    expect(screen.getByRole('tab', { name: 'Boiler watch, not running' })).toBeInTheDocument();
    expect(document.querySelector('[data-problem]')).toBeNull();
    expect(screen.queryByText('The flow is not right.')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Boiler watch/ })).not.toHaveAttribute('data-state', 'refused');

    await userEvent.type(name, ' 2');

    expect(screen.getByRole('tab', { name: 'Boiler watch 2, not running, changes not saved' })).toBeInTheDocument();
    expect(document.querySelector('[data-problem]')).toBeNull();
    expect(screen.queryByText('The flow is not right.')).not.toBeInTheDocument();
  });

  /*
   * A refusal of the server's own copy — a flow tested with no draft — is about that copy, and has
   * no draft to go with. Another console's save puts a copy in its place that nobody here sent, and
   * a delete takes the flow: either way what was refused is not there any more. Switched on or off,
   * the copy is the same copy, and still refused.
   */

  it('of the server\'s copy goes once the server has another copy, and stands while it is only switched', async () => {
    const { kept } = keeping([watch]);
    server.use(http.post('/api/flows/:id/test', () => refusal({ 'node:test': ['Pick a test.'] })));
    const { queryClient } = render(<FlowsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Test' }));
    expect(await screen.findByTitle('Pick a test.')).toHaveAttribute('data-problem');

    await elsewhere(queryClient, () => (kept[0] = { ...watch, enabled: false }));
    expect(screen.getByTitle('Pick a test.')).toHaveAttribute('data-problem');

    await elsewhere(queryClient, () => (kept[0] = { ...watch, enabled: false, name: 'Boiler watch, mended' }));
    expect(screen.getByRole('tab', { name: 'Boiler watch, mended, not running' })).toBeInTheDocument();
    expect(useFlowDraftStore.getState().refusals.watch).toBeUndefined();
    expect(document.querySelector('[data-problem]')).toBeNull();
    expect(screen.queryByText(/so the test did not start/)).not.toBeInTheDocument();
  });

  it('of the server\'s copy goes with its flow, once another console deletes it', async () => {
    const { kept } = keeping([watch, sim]);
    server.use(http.post('/api/flows/:id/test', () => refusal({ 'node:test': ['Pick a test.'] })));
    const { queryClient } = render(<FlowsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Test' }));
    await screen.findByTitle('Pick a test.');

    await elsewhere(queryClient, () => kept.splice(0, 1));

    expect(screen.queryByRole('tab', { name: /^Boiler watch/ })).not.toBeInTheDocument();
    expect(useFlowDraftStore.getState().refusals.watch).toBeUndefined();
  });
});

/**
 * Ids the server's pattern takes, ^[A-Za-z0-9_-]{1,40}$, that every object already answers to: what an
 * object inherits from, the Object function, and a method. Any PUT or test can name a flow so, and
 * every console then reads it.
 */
describe('flows called by a name every object answers to', () => {
  const INHERITED = ['__proto__', 'constructor', 'toString'];
  const called = (id: string): FlowDto => ({ ...watch, id, name: `Flow ${id}`, enabled: false });

  // Should a case fail by putting a run on every object, the cases after it must not find it there.
  afterEach(() => {
    for (const each of [Object.prototype, Object, Object.prototype.toString] as unknown as Array<Record<string, unknown>>)
      for (const kind of ['active', 'test']) delete each[kind];
  });

  it('opens on them, says each one\'s run and prints its lines, and offers Stop only where a test runs', async () => {
    renderPage([watch, ...INHERITED.map(called)]);
    await screen.findByRole('tab', { name: /^Boiler watch/ });

    act(() => {
      useFlowStatusStore
        .getState()
        .setStatus({ runs: [watchRun(), ...INHERITED.map((flowId) => runOf(flowId, { kind: 'test', state: 'running' }))] });
      useFlowStatusStore.getState().addDebug(INHERITED.map((flowId) => printed(flowId, `printed by ${flowId}`)), 0);
    });

    expect(({} as Record<string, unknown>).test).toBeUndefined();
    expect(({} as Record<string, unknown>).active).toBeUndefined();
    // The watch runs, and nothing tests it.
    expect(screen.getByRole('button', { name: 'Test' })).toBeInTheDocument();

    for (const flowId of INHERITED) {
      await userEvent.click(screen.getByRole('tab', { name: new RegExp(`^Flow ${flowId}, running`) }));
      expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
      expect(screen.getByText('Test · running')).toBeInTheDocument();
      expect(within(debugStrip()).getByText(`printed by ${flowId}`)).toBeInTheDocument();
    }

    // Their runs go, and nothing of them stays behind on the flow on screen.
    act(() => useFlowStatusStore.getState().setStatus({ runs: [] }));
    expect(screen.getByRole('tab', { name: 'Flow toString, not running' })).toBeInTheDocument();
    expect(screen.getByText('Off')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test' })).toBeInTheDocument();
  });

  // A test of the server's copy of a flow with no draft is refused of that copy, and the refusal goes
  // once another console saves another copy in its place.
  it('files a refused test of one with no draft against the server\'s copy, which another console\'s save lets go', async () => {
    const { kept } = keeping([called('toString')]);
    server.use(http.post('/api/flows/:id/test', () => refusal({ 'node:test': ['Pick a test.'] })));
    const { queryClient } = render(<FlowsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Test' }));
    expect(await screen.findByTitle('Pick a test.')).toHaveAttribute('data-problem');

    await elsewhere(queryClient, () => (kept[0] = { ...called('toString'), name: 'Flow toString, mended' }));

    expect(screen.getByRole('tab', { name: 'Flow toString, mended, not running' })).toBeInTheDocument();
    expect(Object.hasOwn(useFlowDraftStore.getState().refusals, 'toString')).toBe(false);
    expect(document.querySelector('[data-problem]')).toBeNull();
  });
});
