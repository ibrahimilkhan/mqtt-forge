import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '../../api/queryKeys';
import { useFlowStatusStore } from '../../stores/flowStatusStore';
import { server } from '../../test/server';
import { renderWithClient as render } from '../../test/renderWithClient';
import type { FlowDto, FlowsDto } from '../../types/api';
import { standInForTheBrowser } from './canvasTestbed';
import { useFlowDraftStore } from './flowDraftStore';
import FlowsPage from './FlowsPage';

beforeAll(() => standInForTheBrowser());
afterAll(() => vi.unstubAllGlobals());

beforeEach(() => {
  localStorage.clear();
  useFlowDraftStore.setState({ drafts: {}, current: null, selected: null, refusals: {} });
  useFlowStatusStore.setState({ flows: {}, nodes: {}, debug: [], debugDropped: 0 });
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
