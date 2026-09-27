import type { QueryClient } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Profiler, StrictMode } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '../../api/queryKeys';
import { useFlowAlarmStore } from '../../stores/flowAlarmStore';
import { useFlowStatusStore } from '../../stores/flowStatusStore';
import panelStyles from '../../styles/panel.module.css';
import { server } from '../../test/server';
import { renderWithClient as render } from '../../test/renderWithClient';
import type { FlowDebugDto, FlowDto, FlowNodeDto, FlowsDto, FlowStatusDto } from '../../types/api';
import { standInForTheBrowser } from './canvasTestbed';
import { DebugStrip } from './DebugStrip';
import strip from './DebugStrip.module.css';
import stripSheet from './DebugStrip.module.css?raw';
import { NODE_HEIGHT, NODE_WIDTH } from './FlowCanvas';
import { moveNodes } from './flowDocument';
import { DRAFT_PREFIX, useFlowDraftStore } from './flowDraftStore';
import FlowsPage from './FlowsPage';
import toolbar from './Toolbar.module.css';
import toolbarSheet from './Toolbar.module.css?raw';

beforeAll(() => standInForTheBrowser());
afterAll(() => vi.unstubAllGlobals());

beforeEach(() => {
  localStorage.clear();
  useFlowDraftStore.setState({ drafts: {}, bases: {}, current: null, selected: null, refusals: {}, unkept: false });
  useFlowStatusStore.setState(useFlowStatusStore.getInitialState());
  useFlowAlarmStore.setState({ asked: null });
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

/** What a stylesheet declares for one selector, its comments left out. */
function ruleOf(sheet: string, selector: string) {
  const rules = sheet.replace(/\/\*[\s\S]*?\*\//g, '');
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

/** The answer the server gives a deploy it refuses. */
const refusal = (errors: Record<string, string[]>) =>
  HttpResponse.json(
    { title: 'The flow was not deployed', detail: Object.values(errors)[0][0], reason: 'flowInvalid', errors },
    { status: 400, headers: { 'Content-Type': 'application/problem+json' } },
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
      if (at < 0) return HttpResponse.json({ title: 'No such flow', reason: 'flowUnknown' }, { status: 404 });
      kept.splice(at, 1);
      return new HttpResponse(null, { status: 204 });
    }),
  );

  return { kept, puts, deletes, reads: () => lists };
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

    await userEvent.click(within(await screen.findByRole('group', { name: 'Nodes' })).getByRole('button', { name: /Publish/ }));

    expect(screen.getByRole('heading', { name: 'Publish' })).toBeInTheDocument();
    expect(screen.getByText('1 change')).toBeInTheDocument();
  });

  // Three clicks are three nodes that can each be read and grabbed. Stepped a few pixels from the
  // last, each new node covered the title of the one before and hid its ports under its own.
  it('puts each node the palette adds where it covers no other', async () => {
    keeping();
    render(<FlowsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'New flow' }));
    const palette = within(screen.getByRole('group', { name: 'Nodes' }));

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

  // Taken back to the copy the server had while the change was on its way, the draft is not
  // nothing: the server is about to have the change, and what was typed says to undo it.
  it('keeps an edit taken back while the deploy of it was on its way', async () => {
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

    const name = await screen.findByLabelText('Name');
    await userEvent.type(name, ' 2');
    await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));
    await screen.findByRole('button', { name: 'Deploying…' });
    await userEvent.type(name, '{Backspace}{Backspace}');
    answer.release();

    await screen.findByRole('button', { name: 'Deploy' });
    expect(kept[0].name).toBe('Boiler watch 2');
    expect(screen.getByRole('tab', { name: 'Boiler watch, not running, changes not deployed' })).toBeInTheDocument();
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

  // Remove node takes its own pane away with the node. The reader was working on the canvas.
  it('goes to the canvas when Remove node takes the node away', async () => {
    keeping([watch]);
    render(<FlowsPage />);
    await screen.findByRole('tabpanel');
    fireEvent.click(
      (await within(document.getElementById('flow-canvas')!).findByText('If')).closest<HTMLElement>('.react-flow__node')!,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Remove node' }));

    expect(useFlowDraftStore.getState().drafts.watch.nodes.map((node) => node.id)).toEqual(['in']);
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

    expect(
      await screen.findByRole('tab', { name: 'Boiler watch 2, not running, refused, changes not deployed' }),
    ).toBeInTheDocument();
  });

  // A refused deploy leaves the flow running what it ran before, and the tab says both.
  it('go on saying a flow runs when the server refuses its changes', async () => {
    keeping([watch]);
    server.use(
      http.get('/api/flows/status', () => HttpResponse.json(watchHasSeen(0))),
      http.put('/api/flows/watch', () => refusal({ 'node:test': ['Pick a test.'] })),
    );
    render(<FlowsPage />);
    await screen.findByRole('tab', { name: 'Boiler watch, running' });

    await userEvent.type(screen.getByLabelText('Name'), ' 2');
    await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));

    expect(
      await screen.findByRole('tab', { name: 'Boiler watch 2, running, refused, changes not deployed' }),
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
    await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));
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

    // Said quieter than what was printed, so the words cannot be taken for a topic or a payload.
    expect(within(empty).getByText('no topic')).toHaveClass(strip.none);
    expect(within(empty).getByText('empty payload')).toHaveClass(strip.none);
    expect(within(error).getByText('The flow stopped.')).not.toHaveClass(strip.none);
    expect(stripSheet.replace(/\/\*[\s\S]*?\*\//g, '')).toMatch(/\.none\s*\{[^}]*[{;\s]color:\s*var\(--muted\)/);
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
    useFlowDraftStore.getState().edit(watch, (flow) => ({ ...flow, name: 'Boiler watch 2' }));
    useFlowDraftStore.getState().edit(sim, (flow) => ({ ...flow, name: 'Boiler simulator 2' }));
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
    useFlowDraftStore.getState().edit(watch, (flow) => ({ ...flow }));
    useFlowDraftStore.getState().edit(sim, (flow) => ({ ...flow, name: 'Boiler simulator 2' }));
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
    useFlowDraftStore.getState().edit(watch, (flow) => ({ ...flow, name: 'Boiler watch 2' }));
    useFlowDraftStore.getState().edit(sim, (flow) => ({ ...flow, name: 'Boiler simulator 2' }));
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
    const out: string[] = [];
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
        out.push(String(params.id));
        await (params.id === 'watch' ? watchPut : simPut).until;
        kept[kept.findIndex((one) => one.id === flow.id)] = flow;
        return HttpResponse.json({ flow });
      }),
    );
    useFlowDraftStore.getState().edit(watch, (flow) => ({ ...flow, name: 'Boiler watch 2' }));
    useFlowDraftStore.getState().edit(sim, (flow) => ({ ...flow, name: 'Boiler simulator 2' }));
    useFlowDraftStore.getState().show('watch');
    const { queryClient } = render(<FlowsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Deploy' }));
    // The window comes back into focus while the first flow is on its way, and the list is read.
    // On its way, so after the read Deploy makes of its own before it sends.
    await waitFor(() => expect(out).toEqual(['watch']));
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

/**
 * The spec's limits are two hundred nodes to a flow and pushes up to four times a second. A push
 * that moved nothing on screen draws nothing, and a drag that moves one flow's node checks that one
 * flow for changes, not every draft there is.
 */
describe('at the limits', () => {
  const both = (count: number): FlowStatusDto => ({
    flows: [{
      id: 'watch', faults: 0, fault: null,
      nodes: [
        { id: 'in', count, outs: { out: count }, errors: 0, note: null, standing: [] },
        { id: 'test', count, outs: { yes: 3, no: count - 3 }, errors: 0, note: null, standing: [] },
      ],
    }],
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
    await screen.findByText('412 in');
    await turns();
    commits.mockClear();

    act(() => useFlowStatusStore.getState().setStatus(both(412)));
    await turns();
    const again = commits.mock.calls.length;

    act(() => useFlowStatusStore.getState().setStatus(both(413)));

    expect(again).toBe(0);
    expect(screen.getByText('413 in')).toBeInTheDocument();
  });

  it('checks only the flow that changed for whether it still differs from what is running', async () => {
    const flows = ['a', 'b', 'c'].map((id) => ({ ...watch, id, name: `Flow ${id}` }));
    keeping(flows);
    for (const flow of flows) useFlowDraftStore.getState().edit(flow, (one) => ({ ...one, name: `${one.name} 2` }));
    render(<FlowsPage />);
    await screen.findByText('3 changes');
    const stringify = vi.spyOn(JSON, 'stringify');

    act(() => useFlowDraftStore.getState().edit(flows[0], (one) => moveNodes(one, { in: { x: 48, y: 120 } })));
    const checked = stringify.mock.calls.flatMap(([value]) => {
      const id = (value as { id?: unknown } | null)?.id;
      return typeof id === 'string' ? [id] : [];
    });
    stringify.mockRestore();

    expect(new Set(checked)).toEqual(new Set(['a']));
    expect(screen.getByText('3 changes')).toBeInTheDocument();
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

  // A flow that was never deployed is only a draft, and there is nothing on the server to delete.
  it('drops a flow that was never deployed without asking the server', async () => {
    const { deletes } = keeping();
    render(<FlowsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'New flow' }));

    await userEvent.click(screen.getByRole('button', { name: 'Delete flow' }));
    expect(screen.getByText('Drop Flow 1? It was never deployed.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Delete it' }));

    expect(await screen.findByRole('button', { name: 'Start from an example' })).toBeInTheDocument();
    expect(useFlowDraftStore.getState().drafts).toEqual({});
    expect(deletes).toEqual([]);
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

    expect(await within(pane).findByText("MQTT in → function: That node has no input called 'in'.")).toBeInTheDocument();
    expect(within(pane).getByText("function → Debug: This node has no output called 'out'.")).toBeInTheDocument();
  });

  it('says in the node pane that it does not know the node, and still takes it out', async () => {
    keeping([odd], refused);
    render(<FlowsPage />);

    fireEvent.click(await drawn('function'));

    const pane = screen.getByRole('complementary', { name: 'Inspector' });
    expect(within(pane).getByRole('heading', { name: 'function' })).toBeInTheDocument();
    expect(within(pane).getByText(/^This build does not know a node called “function”/)).toBeInTheDocument();

    await userEvent.click(within(pane).getByRole('button', { name: 'Remove node' }));

    expect(useFlowDraftStore.getState().drafts.odd.nodes.map((node) => node.id)).toEqual(['in', 'print']);
    expect(useFlowDraftStore.getState().drafts.odd.edges).toEqual([]);
  });

  it('names the node in the debug strip by its type', async () => {
    keeping([odd], refused);
    render(<FlowsPage />);
    await drawn('function');

    act(() => useFlowStatusStore.getState().addDebug([{ flowId: 'odd', nodeId: 'fn', at: '2026-09-26T09:14:22Z', kind: 'error', topic: '', text: 'It stopped.' }], 0));

    const line = within(screen.getByRole('region', { name: 'Debug' })).getByText('It stopped.').closest('li')!;
    expect(within(line).getByText('function')).toBeInTheDocument();
  });
});

/**
 * Two consoles editing two different flows must not undo each other's work. A draft that holds
 * nothing of the reader's goes; one started from a copy the server has since replaced or deleted
 * is not deployed over the newer copy unless the reader says so.
 */
describe('a draft and the server\'s copy', () => {
  /** The watch as another console deployed it: the If now asks for more than 95. */
  const v2: FlowDto = { ...watch, nodes: [watch.nodes[0], { ...watch.nodes[1], config: { ...watch.nodes[1].config, value: '95' } }] };

  /**
   * Another console deploys or deletes, and this one reads the list again. The query tells the page
   * a turn of the clock after the read comes back, so the turns are waited for too.
   */
  const elsewhere = async (queryClient: QueryClient, change: () => void) => {
    change();
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.flows }));
    await turns();
  };

  // The reviewer's sequence: a letter typed and taken back left a draft of v1 behind, which hid
  // another console's v2, and went out with the next Deploy of an unrelated flow.
  it('keeps no draft of an edit taken back, so another console\'s deploy is neither hidden nor undone', async () => {
    const { kept, puts } = keeping([watch]);
    const { queryClient } = render(<FlowsPage />);
    const name = await screen.findByLabelText('Name');

    await userEvent.type(name, 'x');
    await userEvent.type(name, '{Backspace}');
    expect(screen.getByText('All deployed')).toBeInTheDocument();
    expect(localStorage.getItem(DRAFT_PREFIX + 'watch')).toBeNull();

    await elsewhere(queryClient, () => (kept[0] = v2));
    expect(await screen.findByText('$.temp > 95')).toBeInTheDocument();
    expect(screen.getByText('All deployed')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'New flow' }));
    await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));

    await waitFor(() => expect(puts.map((flow) => flow.name)).toEqual(['Flow 1']));
    expect(kept.find((flow) => flow.id === 'watch')).toEqual(v2);
  });

  it('drops a draft that is back to what is running however it got there, and leaves the pick alone', async () => {
    keeping([watch]);
    render(<FlowsPage />);
    const run = await screen.findByRole('checkbox', { name: 'Run it once deployed' });

    await userEvent.click(run);
    await userEvent.click(run);
    expect(useFlowDraftStore.getState().drafts.watch).toBeUndefined();

    act(() => useFlowDraftStore.getState().select('test'));
    act(() => useFlowDraftStore.getState().edit(watch, (flow) => moveNodes(flow, { test: { x: 348, y: 120 } })));
    expect(screen.getByText('1 change')).toBeInTheDocument();
    act(() => useFlowDraftStore.getState().edit(watch, (flow) => moveNodes(flow, { test: { x: 300, y: 120 } })));

    expect(useFlowDraftStore.getState().drafts.watch).toBeUndefined();
    expect(screen.getByText('All deployed')).toBeInTheDocument();
    expect(useFlowDraftStore.getState().selected).toBe('test');
    expect(screen.getByRole('heading', { name: 'If' })).toBeInTheDocument();
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
    expect(screen.getByText('1 held back')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deploy' })).toBeDisabled();

    // Deploy sends the rest and leaves this one out.
    await userEvent.click(screen.getByRole('button', { name: 'New flow' }));
    expect(screen.getByText('1 change · 1 held back')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));
    await waitFor(() => expect(puts.map((flow) => flow.name)).toEqual(['Flow 1']));
    expect(await screen.findByText('1 held back')).toBeInTheDocument();
    expect(kept.find((flow) => flow.id === 'watch')).toEqual(v2);

    // Kept, it is an ordinary change, and goes with the next Deploy.
    await userEvent.click(screen.getByRole('tab', { name: /^Boiler watch 2/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Keep mine' }));
    expect(screen.getByRole('tab', { name: 'Boiler watch 2, not running, changes not deployed' })).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole('tab', { selected: true }));
    await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));

    await waitFor(() => expect(puts.map((flow) => flow.name)).toEqual(['Flow 1', 'Boiler watch 2']));
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
    expect(screen.getByText('All deployed')).toBeInTheDocument();
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
    expect(screen.getByText('All deployed')).toBeInTheDocument();
  });

  // A flow deleted on another console must not come back as a new one with the next Deploy.
  it('holds back an edit of a flow another console has since deleted, and deploys it again only when kept', async () => {
    const { kept, puts } = keeping([watch, sim]);
    // On the watch's tab, as a reader who picked it is. With no flow picked the page shows the
    // first, and a flow the server no longer has goes to the end of the row.
    useFlowDraftStore.getState().show('watch');
    const { queryClient } = render(<FlowsPage />);
    await userEvent.type(await screen.findByLabelText('Name'), ' 2');

    await elsewhere(queryClient, () => kept.splice(0, 1));

    expect(await screen.findByRole('tab', { name: 'Boiler watch 2, deleted on the server since you started' })).toBeInTheDocument();
    expect(screen.getByText(/^Deleted on the server since you started/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deploy' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Keep mine' }));
    expect(screen.getByRole('tab', { name: 'Boiler watch 2, not deployed' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));

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

  // Drafts kept before they remembered where they started are taken to be of the copy the server
  // has when the page first reads it, as they always were, and are held to it from then on.
  it('places a draft kept before drafts remembered their start on the copy the server has now', async () => {
    const { kept } = keeping([watch]);
    localStorage.setItem(DRAFT_PREFIX + 'watch', JSON.stringify({ version: 1, flow: { ...watch, name: 'Boiler watch 2' } }));
    vi.resetModules();
    const { default: Reopened } = await import('./FlowsPage');
    const { queryClient } = render(<Reopened />);

    expect(await screen.findByText('1 change')).toBeInTheDocument();

    await elsewhere(queryClient, () => (kept[0] = v2));
    expect(await screen.findByText('1 held back')).toBeInTheDocument();
  });

  /*
   * Two consoles side by side on two screens: neither is ever brought back into focus, and neither
   * hears the other deploy, so the list the page read last is all it knows. Deploy reads the list
   * itself before it sends anything.
   */

  it('reads the list before it sends, and holds back a draft another console has overtaken since', async () => {
    const { kept, puts, reads } = keeping([watch]);
    render(<FlowsPage />);
    await userEvent.type(await screen.findByLabelText('Name'), ' 2');
    const before = reads();

    // Another console deploys the watch, and this one is not told.
    kept[0] = v2;
    await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));

    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    expect(puts).toEqual([]);
    expect(
      await screen.findByRole('tab', { name: 'Boiler watch 2, not running, changed on the server since you started' }),
    ).toBeInTheDocument();
    expect(screen.getByText('1 held back')).toBeInTheDocument();
    expect(screen.getByText(/^Changed on the server since you started/)).toBeInTheDocument();
    expect(puts).toEqual([]);
    expect(kept[0]).toEqual(v2);
  });

  it('sends the drafts that still stand on the server\'s copy, and holds back only the one overtaken', async () => {
    const { kept, puts } = keeping([watch, sim]);
    useFlowDraftStore.getState().edit(watch, (flow) => ({ ...flow, name: 'Boiler watch 2' }));
    useFlowDraftStore.getState().edit(sim, (flow) => ({ ...flow, name: 'Boiler simulator 2' }));
    render(<FlowsPage />);
    await screen.findByText('2 changes');

    kept[0] = v2;
    await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));

    await waitFor(() => expect(puts.map((flow) => flow.name)).toEqual(['Boiler simulator 2']));
    expect(await screen.findByText('1 held back')).toBeInTheDocument();
    expect(kept.find((flow) => flow.id === 'watch')).toEqual(v2);
  });

  it('brings back no flow another console has deleted since, however the page last saw it', async () => {
    const { kept, puts, reads } = keeping([watch, sim]);
    useFlowDraftStore.getState().show('watch');
    render(<FlowsPage />);
    await userEvent.type(await screen.findByLabelText('Name'), ' 2');
    const before = reads();

    kept.splice(0, 1);
    await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));

    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    expect(puts).toEqual([]);
    expect(await screen.findByRole('tab', { name: 'Boiler watch 2, deleted on the server since you started' })).toBeInTheDocument();
    expect(kept.map((flow) => flow.id)).toEqual(['sim']);
  });

  // Without the list there is no telling which drafts another console has overtaken, so nothing
  // goes, and the page says why rather than leaving the reader with a Deploy that did nothing.
  it('sends nothing when the list cannot be read first, and says so', async () => {
    const { puts } = keeping([watch]);
    render(<FlowsPage />);
    await userEvent.type(await screen.findByLabelText('Name'), ' 2');
    server.use(http.get('/api/flows', () => couldNot('The server is starting.', 503)));

    await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));

    const said = 'Not deployed. The flows could not be read from the server first, so nothing was sent. The server is starting.';
    expect(await screen.findByText(said)).toBeInTheDocument();
    expect(outcome(said)).not.toBeNull();
    expect(puts).toEqual([]);
    expect(screen.getByText('1 change')).toBeInTheDocument();
  });
});

/** The answer the server gives a request it could not carry out, for a reason that is not about the flow. */
const couldNot = (detail: string, status = 500) =>
  HttpResponse.json(
    { title: 'Could not do that', detail, reason: 'flowsNotSaved' },
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );

/** The line under the tabs that says what did not go through, as a screen reader is told it. */
const outcome = (text: string | RegExp) => screen.getByText(text).closest('[aria-live="polite"]');

/**
 * What the reader asked of the server that did not go through. The page covers the log, so each is
 * said under the tabs, where a deploy that did not go through is said — and in one polite live
 * region, so a reader who cannot see the marks it leaves is told as well.
 */
describe('what did not go through', () => {
  /** A flow with an Inject node, running, so its ▶ can be pressed. */
  const press: FlowDto = {
    id: 'press',
    name: 'Fan test',
    enabled: true,
    nodes: [{ id: 'go', type: 'inject', x: 40, y: 80, config: { topic: 'plant/k1/cmd', payload: '{"fan":"on"}' } }],
    edges: [],
  };
  const pressRuns: FlowStatusDto = {
    flows: [{ id: 'press', faults: 0, fault: null, nodes: [{ id: 'go', count: 0, outs: {}, errors: 0, note: null, standing: [] }] }],
  };

  it('says a deploy that failed in a live region of its own, not over the whole page', async () => {
    keeping([watch]);
    server.use(http.put('/api/flows/watch', () => couldNot('The disk is full.')));
    render(<FlowsPage />);

    await userEvent.click(await screen.findByRole('checkbox', { name: 'Run it once deployed' }));
    await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));

    await screen.findByText('Not deployed. The disk is full.');
    const region = outcome('Not deployed. The disk is full.');
    expect(region).not.toBeNull();
    expect(region).not.toContainElement(screen.getByRole('tablist'));
    expect(region).not.toContainElement(screen.getByRole('tabpanel'));
  });

  // A refusal marks the nodes it is about, and a flow refused on another tab has only its tab's
  // lamp to show it. A screen reader was told nothing at all.
  it('says which flows the server refused, and stops once their refusals lapse', async () => {
    keeping([watch]);
    server.use(http.put('/api/flows/watch', () => refusal({ 'node:test': ['Pick a test.'] })));
    render(<FlowsPage />);
    const name = await screen.findByLabelText('Name');

    await userEvent.type(name, ' 2');
    await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));

    const said = /^The server refused Boiler watch 2, so it was not deployed\./;
    expect(await screen.findByText(said)).toBeInTheDocument();
    expect(outcome(said)).not.toBeNull();

    // Taken back to what is running, the draft goes, and its refusal with it.
    await userEvent.type(name, '{Backspace}{Backspace}');
    expect(screen.queryByText(said)).not.toBeInTheDocument();
  });

  // The numbers are pushed four times a second. A live region they reached would be read out on
  // every push.
  it('says nothing new when the numbers are pushed', async () => {
    keeping([watch]);
    server.use(http.put('/api/flows/watch', () => refusal({ 'node:test': ['Pick a test.'] })));
    render(<FlowsPage />);
    await userEvent.type(await screen.findByLabelText('Name'), ' 2');
    await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));
    const region = (await screen.findByText(/^The server refused/)).closest('[aria-live="polite"]')!;

    const changes: MutationRecord[] = [];
    const watcher = new MutationObserver((records) => changes.push(...records));
    watcher.observe(region, { subtree: true, childList: true, characterData: true, attributes: true });
    act(() => useFlowStatusStore.getState().setStatus(watchHasSeen(1)));
    act(() => useFlowStatusStore.getState().setStatus(watchHasSeen(2)));
    act(() => useFlowStatusStore.getState().setStatus({ flows: [] }));
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
    // Off while the delete is out, but said rather than set, as Deploy is: a button switched off
    // in the hand that pressed it loses the focus in some browsers.
    const deleting = screen.getByRole('button', { name: 'Delete it' });
    expect(deleting).toBeEnabled();
    expect(deleting).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(deleting);
    answer.release();

    expect(await screen.findByText('Not deleted. The disk is full.')).toBeInTheDocument();
    expect(outcome('Not deleted. The disk is full.')).not.toBeNull();
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
    expect(screen.queryByText(/^Not deleted/)).not.toBeInTheDocument();
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

  it('says a message that was not injected, until the next press', async () => {
    keeping([press]);
    server.use(
      http.get('/api/flows/status', () => HttpResponse.json(pressRuns)),
      http.post('/api/flows/:flow/nodes/:node/inject', () =>
        couldNot("No running flow 'press' has an Inject node 'go'. Deploy the flow first.", 404),
      ),
    );
    render(<FlowsPage />);
    const inject = await screen.findByRole('button', { name: 'Inject' });
    await waitFor(() => expect(inject).toBeEnabled());

    fireEvent.click(inject);

    const said = "Not injected. No running flow 'press' has an Inject node 'go'. Deploy the flow first.";
    expect(await screen.findByText(said)).toBeInTheDocument();
    expect(outcome(said)).not.toBeNull();

    server.use(http.post('/api/flows/:flow/nodes/:node/inject', () => new HttpResponse(null, { status: 202 })));
    fireEvent.click(inject);
    await waitFor(() => expect(screen.queryByText(said)).not.toBeInTheDocument());
  });
});

/**
 * A flow alarm's row on the alarm wall opens this page, on the flow the alarm came from with its
 * Alarm node picked. The node's pane lists the alarms it holds up; the Alerts panel, a list of
 * rules, has nothing to say about one.
 */
describe('a flow alarm the reader asked to see', () => {
  const alarmed: FlowDto = {
    ...watch,
    nodes: [
      ...watch.nodes,
      {
        id: 'hot', type: 'alarm', x: 580, y: 40,
        config: { name: 'Boiler too hot', severity: 'warn', reason: '{{topic}}', value: '', sound: false, webhook: '', publish: false, publishTopic: '', qos: 1, retain: false },
      },
    ],
    edges: [...watch.edges, { id: 'e2', from: 'test', fromPort: 'yes', to: 'hot', toPort: 'raise' }],
  };
  const inspecting = () => within(screen.getByRole('complementary', { name: 'Inspector' }));

  it('opens on the flow it came from, with its Alarm node picked', async () => {
    keeping([sim, alarmed]);
    useFlowAlarmStore.getState().ask('flow-watch-hot');
    render(<FlowsPage />);

    expect(await screen.findByRole('tab', { name: /^Boiler watch/, selected: true })).toBeInTheDocument();
    expect(inspecting().getByRole('heading', { name: 'Alarm' })).toBeInTheDocument();
    expect(useFlowAlarmStore.getState().asked).toBeNull();
  });

  it('turns to it when asked with the page already open', async () => {
    keeping([sim, alarmed]);
    render(<FlowsPage />);
    await screen.findByText('Boiler simulator', { selector: 'h3' });

    act(() => useFlowAlarmStore.getState().ask('flow-watch-hot'));

    expect(screen.getByRole('tab', { name: /^Boiler watch/, selected: true })).toBeInTheDocument();
    expect(inspecting().getByRole('heading', { name: 'Alarm' })).toBeInTheDocument();
  });

  it('lets the question go when the flow is not there any more', async () => {
    keeping([sim]);
    useFlowAlarmStore.getState().ask('flow-watch-hot');
    render(<FlowsPage />);

    expect(await screen.findByText('Boiler simulator', { selector: 'h3' })).toBeInTheDocument();
    await waitFor(() => expect(useFlowAlarmStore.getState().asked).toBeNull());
  });
});

/**
 * What the server says of a running flow besides its counts: each node's last word — the value it
 * read, or what went wrong — and what stopped the flow. The page covers the log, so these are the
 * only places they are said.
 */
describe('what a running flow says', () => {
  const refusedFilter = (fault: string | null = null): FlowStatusDto => ({
    flows: [{
      id: 'watch', faults: fault ? 1 : 0, fault,
      nodes: [
        { id: 'in', count: 0, outs: {}, errors: 1, note: 'The broker refused this filter.', standing: [] },
        { id: 'test', count: 0, outs: {}, errors: 0, note: null, standing: [] },
      ],
    }],
  });

  it('says why a node counts an error, on its status line and in its pane', async () => {
    keeping([watch]);
    server.use(http.get('/api/flows/status', () => HttpResponse.json(refusedFilter())));
    render(<FlowsPage />);

    const line = await screen.findByText('0 in · 1 error');
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
});

describe('drafts kept from an earlier visit', () => {
  // What storage holds outlives the build that wrote it. A draft short of a name, kept as the
  // flow on screen, took the page down on every open, and a reload landed on it again.
  it('open the page when one of them is not a whole flow', async () => {
    keeping([watch]);
    localStorage.setItem('mqttforge.flows.drafts', JSON.stringify({ state: { drafts: { broken: { id: 'broken' } }, current: 'broken' }, version: 0 }));
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
