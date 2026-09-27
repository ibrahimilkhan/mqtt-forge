import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFlowStatusStore } from '../../stores/flowStatusStore';
import { server } from '../../test/server';
import { renderWithClient as render } from '../../test/renderWithClient';
import type { FlowDebugDto, FlowDto } from '../../types/api';
import { useFlowDraftStore } from './flowDraftStore';
import { Inspector } from './Inspector';
import { Palette } from './Palette';

const facts = { allowWebhooks: true, alertTopicPrefix: 'mqttforge/alerts/' };

const watch: FlowDto = {
  id: 'watch',
  name: 'Boiler watch',
  enabled: true,
  nodes: [
    { id: 'test', type: 'if', x: 0, y: 0, config: { field: '$.temp', test: 'gt', value: '90', value2: '' } },
    {
      id: 'hot', type: 'alarm', x: 0, y: 0,
      config: { name: 'Too hot', severity: 'warn', reason: '{{topic}}', value: '', sound: false, webhook: '', publish: false, publishTopic: '', qos: 1, retain: false },
    },
  ],
  edges: [],
};

// The flow on screen is always the draft when there is one, so a test reads it from the store.
const shown = () => useFlowDraftStore.getState().drafts.watch ?? watch;

function Inspecting({ running = true }: { running?: boolean }) {
  const flow = useFlowDraftStore((state) => state.drafts.watch) ?? watch;
  return <Inspector flow={flow} deployed={watch} running={running} overtaken={false} problems={{}} facts={facts} />;
}

beforeEach(() => {
  localStorage.clear();
  useFlowDraftStore.setState({ drafts: {}, bases: {}, current: 'watch', selected: null, refusals: {} });
  useFlowStatusStore.setState(useFlowStatusStore.getInitialState());
});

describe('palette', () => {
  it('lists every node under its group, and a click asks for that node', async () => {
    const added: string[] = [];
    render(<Palette onAdd={(type) => added.push(type)} />);

    for (const heading of ['Triggers', 'Logic', 'Actions'])
      expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Publish/ }));
    expect(added).toEqual(['publish']);
  });

  // Every item in it adds a node; none of them goes anywhere. A navigation landmark would be listed
  // among the page's ways around, and lead a reader who took it to a row of actions.
  it('stands as a named group of actions, not as a landmark to find the way by', () => {
    render(<Palette onAdd={() => {}} />);

    expect(screen.getByRole('group', { name: 'Nodes' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });
});

describe('inspector', () => {
  it('shows the flow\'s own settings when no node is picked, and edits them as a draft', async () => {
    render(<Inspecting />);

    const name = screen.getByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Boiler house');

    expect(shown().name).toBe('Boiler house');
    expect(screen.getByText('Running.')).toBeInTheDocument();
  });

  it('turns a flow off as part of the draft', async () => {
    render(<Inspecting />);

    await userEvent.click(screen.getByRole('checkbox', { name: 'Run it once deployed' }));

    expect(shown().enabled).toBe(false);
  });

  it('shows the picked node\'s settings and writes each change to the draft', async () => {
    useFlowDraftStore.getState().select('test');
    render(<Inspecting />);

    const value = screen.getByLabelText('Value');
    await userEvent.clear(value);
    await userEvent.type(value, '95');
    await userEvent.selectOptions(screen.getByLabelText('Test'), 'lte');

    expect(shown().nodes[0].config).toMatchObject({ field: '$.temp', test: 'lte', value: '95' });
  });

  it('asks for a second value only for between, and none for exists', async () => {
    useFlowDraftStore.getState().select('test');
    render(<Inspecting />);

    await userEvent.selectOptions(screen.getByLabelText('Test'), 'between');
    expect(screen.getByLabelText('And')).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('Test'), 'exists');
    expect(screen.queryByLabelText('Value')).not.toBeInTheDocument();
  });

  it('lists the alarms an Alarm node is holding up', () => {
    useFlowDraftStore.getState().select('hot');
    useFlowStatusStore.getState().setStatus({
      flows: [{
        id: 'watch', faults: 0, fault: null,
        nodes: [{ id: 'hot', count: 3, outs: { raised: 1 }, errors: 0, note: null,
          standing: [{ topic: 'plant/k1/temp', firedAt: '2026-09-26T09:14:00Z', reason: 'k1 is at 94.2 °C', count: 3 }] }],
      }],
    });

    render(<Inspecting />);

    expect(screen.getByText('plant/k1/temp')).toBeInTheDocument();
    expect(screen.getByText('k1 is at 94.2 °C')).toBeInTheDocument();
  });

  // An Alarm written into flows.json by hand can come with no level, or one the server does not
  // know. The server says to pick one, and the form must not look as though one were picked.
  it.each([
    ['no level', undefined],
    ['a level the server does not know', 'loud'],
  ])('picks no level for an Alarm node with %s, and takes the one the reader picks', async (_, severity) => {
    const [test, hot] = watch.nodes;
    const odd = { ...watch, nodes: [test, { ...hot, config: { ...hot.config, severity } }] };
    useFlowDraftStore.getState().select('hot');
    render(<Inspector flow={odd} deployed={odd} running overtaken={false} problems={{}} facts={facts} />);

    for (const level of ['Info', 'Warn', 'Critical']) expect(screen.getByRole('radio', { name: level })).not.toBeChecked();

    await userEvent.click(screen.getByRole('radio', { name: 'Critical' }));
    expect(useFlowDraftStore.getState().drafts.watch.nodes[1].config.severity).toBe('critical');
  });

  it('says when this host will not send webhooks', () => {
    useFlowDraftStore.getState().select('hot');
    render(<Inspector flow={watch} deployed={watch} running overtaken={false} problems={{}} facts={{ ...facts, allowWebhooks: false }} />);

    expect(screen.getByText(/Webhooks are turned off on this host/)).toBeInTheDocument();
  });

  it('removes the picked node and its wires', async () => {
    useFlowDraftStore.getState().select('test');
    render(<Inspecting />);

    await userEvent.click(screen.getByRole('button', { name: 'Remove node' }));

    expect(shown().nodes.map((node) => node.id)).toEqual(['hot']);
    expect(useFlowDraftStore.getState().selected).toBeNull();
  });

  it('deletes a deployed flow only after asking, on the server', async () => {
    const deleted = vi.fn();
    server.use(
      http.delete('/api/flows/watch', () => {
        deleted();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    render(<Inspecting />);

    await userEvent.click(screen.getByRole('button', { name: 'Delete flow' }));
    expect(deleted).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Delete it' }));
    await vi.waitFor(() => expect(deleted).toHaveBeenCalledOnce());
    expect(useFlowDraftStore.getState().current).toBeNull();
  });

  // What a flow printed is kept per flow until its strip is cleared, and a deleted flow's strip is
  // gone with it: nothing else would ever let its lines go.
  it('lets go of what a deleted flow printed, and of no other flow\'s', async () => {
    server.use(http.delete('/api/flows/watch', () => new HttpResponse(null, { status: 204 })));
    const line = (flowId: string): FlowDebugDto => ({
      flowId, nodeId: 'test', at: '2026-09-26T09:14:22Z', kind: 'message', topic: 'plant/k1/temp', text: '94.2',
    });
    const status = useFlowStatusStore.getState();
    status.addDebug([line('watch'), line('fan')], 1);
    status.clearDebug('watch');
    status.addDebug([line('watch')], 0);
    render(<Inspecting />);

    await userEvent.click(screen.getByRole('button', { name: 'Delete flow' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete it' }));

    await vi.waitFor(() => expect(useFlowStatusStore.getState().debug.watch).toBeUndefined());
    expect(useFlowStatusStore.getState().debugClearedAt.watch).toBeUndefined();
    expect(useFlowStatusStore.getState().debug.fan).toHaveLength(1);
  });
});
