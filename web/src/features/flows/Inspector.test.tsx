import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFlowStatusStore } from '../../stores/flowStatusStore';
import { server } from '../../test/server';
import { renderWithClient as render } from '../../test/renderWithClient';
import type { FlowDebugDto, FlowDto, FlowNodeType } from '../../types/api';
import { useFlowDraftStore } from './flowDraftStore';
import { Inspector } from './Inspector';
import { NODE_SPECS } from './nodeTypes';
import { Palette } from './Palette';
import { forgetDrafts, runOf } from './canvasTestbed';

const facts = { allowWebhooks: true };

const watch: FlowDto = {
  id: 'watch',
  name: 'Boiler watch',
  enabled: true,
  nodes: [
    { id: 'test', type: 'if', x: 0, y: 0, config: { field: '$.temp', test: 'gt', value: '90', value2: '' } },
    { id: 'hot', type: 'alarmRaise', x: 0, y: 0, config: { name: 'Too hot', level: 'warn', reason: '{{topic}}', value: '' } },
  ],
  edges: [],
  variables: [],
};

// The flow on screen is always the draft when there is one, so a test reads it from the store.
const shown = () => useFlowDraftStore.getState().drafts.watch ?? watch;

function Inspecting({ running = true }: { running?: boolean }) {
  const flow = useFlowDraftStore((state) => state.drafts.watch) ?? watch;
  return <Inspector flow={flow} deployed={watch} running={running} overtaken={false} problems={{}} facts={facts} />;
}

/**
 * One node of every kind, each with the settings the palette puts it down with, in a flow with two
 * variables a Set can pick and a second Raise alarm a Clear alarm can pick. Each node's id is its
 * type.
 */
const kinds: FlowDto = {
  id: 'kinds',
  name: 'Every kind',
  enabled: false,
  variables: [
    { name: 'limit', value: '90' },
    { name: 'sensors', value: '["k1","k2","k3"]' },
  ],
  nodes: [
    ...(Object.keys(NODE_SPECS) as FlowNodeType[]).map((type, at) => ({
      id: type,
      type,
      x: 0,
      y: at * 100,
      config: type === 'alarmRaise' ? { ...NODE_SPECS.alarmRaise.defaults(), name: 'Boiler too hot' } : NODE_SPECS[type].defaults(),
    })),
    { id: 'stuck', type: 'alarmRaise', x: 240, y: 0, config: { ...NODE_SPECS.alarmRaise.defaults(), name: 'Fan stuck' } },
  ],
  edges: [],
};

/** A flow's node panes, as the page draws them: the flow's draft once it has one. */
function Forms({ flow, allowWebhooks }: { flow: FlowDto; allowWebhooks: boolean }) {
  const shownFlow = useFlowDraftStore((state) => state.drafts[flow.id]) ?? flow;
  return (
    <Inspector flow={shownFlow} deployed={flow} running={false} overtaken={false} problems={{}} facts={{ ...facts, allowWebhooks }} />
  );
}

/** The pane of one node, picked as a click on the canvas picks it. */
const formOf = (nodeId: string, { flow = kinds, allowWebhooks = true }: { flow?: FlowDto; allowWebhooks?: boolean } = {}) => {
  useFlowDraftStore.getState().select(nodeId);
  render(<Forms flow={flow} allowWebhooks={allowWebhooks} />);
};

/** One setting of one node of the kinds flow, as the draft now has it. */
const setting = (nodeId: string, key: string) =>
  (useFlowDraftStore.getState().drafts.kinds ?? kinds).nodes.find((node) => node.id === nodeId)!.config[key];

/** What a select offers, as the reader reads it. */
const offered = (label: string) => within(screen.getByLabelText(label)).getAllByRole('option').map((option) => option.textContent);

beforeEach(() => {
  localStorage.clear();
  forgetDrafts('watch');
  useFlowStatusStore.setState(useFlowStatusStore.getInitialState());
});

describe('palette', () => {
  // The Start is not among them: a flow has the one it was made with, and every run begins there.
  it('lists every node a reader can put down under its group, and a click asks for that node', async () => {
    const added: string[] = [];
    render(<Palette onAdd={(type) => added.push(type)} />);

    expect(screen.getAllByRole('heading').map((heading) => heading.textContent)).toEqual(['Input', 'Control', 'Actions', 'Alarm']);
    expect(screen.queryByRole('button', { name: /^Start/ })).not.toBeInTheDocument();

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

  it('lists the alarms a Raise alarm node is holding up', () => {
    useFlowDraftStore.getState().select('hot');
    useFlowStatusStore.getState().setStatus({
      runs: [runOf('watch', {
        nodes: [{ id: 'hot', count: 3, outs: { raised: 1 }, errors: 0, note: null,
          standing: [{ topic: 'plant/k1/temp', firedAt: '2026-09-26T09:14:00Z', reason: 'k1 is at 94.2 °C', count: 3 }] }],
      })],
    });

    render(<Inspecting />);

    expect(screen.getByText('plant/k1/temp')).toBeInTheDocument();
    expect(screen.getByText('k1 is at 94.2 °C')).toBeInTheDocument();
  });

  // A wire has no pane, so the flow's pane says what the server refused about it, by its ends. By
  // type alone, two nodes of one type read "If → If", and the reader could not tell which wire.
  it('names the ends of a refused wire as they are drawn, by type and by the line under it', () => {
    const [test] = watch.nodes;
    const twice: FlowDto = {
      ...watch,
      nodes: [test, { ...test, id: 'hotter', x: 260, config: { ...test.config, value: '95' } }],
      edges: [{ id: 'e1', from: 'test', fromPort: 'yes', to: 'hotter', toPort: 'in' }],
    };
    render(
      <Inspector flow={twice} deployed={twice} running overtaken={false} problems={{ 'edge:e1': ['Not this wire.'] }} facts={facts} />,
    );

    expect(screen.getByText('If ($.temp > 90) → If ($.temp > 95): Not this wire.')).toBeInTheDocument();
  });

  // What a Notify says can be a whole sentence, which the canvas cuts to the node's width.
  it('cuts a long line when it names a wire\'s end by it', () => {
    const [test] = watch.nodes;
    const text = 'Boiler k1 is at 94.2 C and still climbing, so its relief valve is opening';
    const told: FlowDto = {
      ...watch,
      nodes: [{ id: 'tell', type: 'notify', x: 0, y: 0, config: { text, level: 'warn' } }, test],
      edges: [{ id: 'e1', from: 'tell', fromPort: 'out', to: 'test', toPort: 'in' }],
    };
    render(
      <Inspector flow={told} deployed={told} running overtaken={false} problems={{ 'edge:e1': ['Not this wire.'] }} facts={facts} />,
    );

    expect(screen.getByText(`Notify (${text.slice(0, 29)}…) → If ($.temp > 90): Not this wire.`)).toBeInTheDocument();
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
    useFlowDraftStore.getState().put({ ...watch, name: 'Boiler watch 2' });
    render(<Inspecting />);

    await userEvent.click(screen.getByRole('button', { name: 'Delete flow' }));
    expect(deleted).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Delete it' }));
    await vi.waitFor(() => expect(deleted).toHaveBeenCalledOnce());
    // Its draft goes with it: kept, it would bring the flow back with the next Deploy.
    await vi.waitFor(() => expect(useFlowDraftStore.getState().drafts).toEqual({}));
  });

  // What a flow printed is kept per flow until its strip is cleared, and a deleted flow's strip is
  // gone with it: nothing else would ever let its lines go.
  it('lets go of what a deleted flow printed, and of no other flow\'s', async () => {
    server.use(http.delete('/api/flows/watch', () => new HttpResponse(null, { status: 204 })));
    const line = (flowId: string): FlowDebugDto => ({
      flowId, nodeId: 'test', at: '2026-09-26T09:14:22Z', kind: 'message', topic: 'plant/k1/temp', text: '94.2', test: false,
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

/**
 * One form for each kind of node, each box under the label a reader reads and writing the setting
 * the server reads under its own key. Nothing is checked as it is typed: the server is the one
 * judge of a setting, and says what is wrong on the node it is about.
 */
describe('the node forms', () => {
  it('sets up an MQTT in: the filter it reads, and whether retained values count', async () => {
    formOf('mqttIn');

    await userEvent.type(screen.getByLabelText('Filter'), 'plant/+/temp');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Also read retained values sent at subscribe' }));

    expect(setting('mqttIn', 'filter')).toBe('plant/+/temp');
    expect(setting('mqttIn', 'replay')).toBe(true);
  });

  it('sets up an If: the field, its test and the value, a second value only for between and none for exists', async () => {
    formOf('if');

    await userEvent.type(screen.getByLabelText('Field'), '$.temp');
    await userEvent.selectOptions(screen.getByLabelText('Test'), 'gte');
    await userEvent.type(screen.getByLabelText('Value'), '90');
    expect(screen.queryByLabelText('And')).not.toBeInTheDocument();
    expect([setting('if', 'field'), setting('if', 'test'), setting('if', 'value')]).toEqual(['$.temp', 'gte', '90']);

    await userEvent.selectOptions(screen.getByLabelText('Test'), 'between');
    await userEvent.type(screen.getByLabelText('And'), '100');
    expect(setting('if', 'value2')).toBe('100');

    await userEvent.selectOptions(screen.getByLabelText('Test'), 'exists');
    expect(screen.queryByLabelText('Value')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('And')).not.toBeInTheDocument();
    // What the hidden boxes held is kept: the server does not read a value the test does not ask for.
    expect([setting('if', 'value'), setting('if', 'value2')]).toEqual(['90', '100']);
  });

  it('sets up a For: how many turns, or forever, which leaves the count as it was and out of reach', async () => {
    formOf('for');
    const times = screen.getByLabelText('Times');

    await userEvent.clear(times);
    await userEvent.type(times, '5');
    expect(setting('for', 'times')).toBe('5');

    await userEvent.click(screen.getByRole('checkbox', { name: 'Forever' }));
    expect(setting('for', 'forever')).toBe(true);
    expect(times).toBeDisabled();
    expect(setting('for', 'times')).toBe('5');
  });

  it('sets up a For each: the array it goes through', async () => {
    formOf('forEach');

    await userEvent.type(screen.getByLabelText('Array'), 'var.sensors');

    expect(setting('forEach', 'array')).toBe('var.sensors');
  });

  it('sets up a Wait: the seconds it holds the run', async () => {
    formOf('wait');
    const seconds = screen.getByLabelText('Seconds');

    await userEvent.clear(seconds);
    await userEvent.type(seconds, '2.5');

    expect(setting('wait', 'seconds')).toBe('2.5');
  });

  it("sets up a Set: one of the flow's variables, and the value it gives it", async () => {
    formOf('set');

    expect(offered('Variable')).toEqual(['Pick a variable', 'limit', 'sensors']);
    await userEvent.selectOptions(screen.getByLabelText('Variable'), 'limit');
    await userEvent.type(screen.getByLabelText('Value'), '95');

    expect(setting('set', 'variable')).toBe('limit');
    expect(setting('set', 'value')).toBe('95');
  });

  it('says where a Set finds a variable to pick, in a flow that has none', () => {
    formOf('set', { flow: { ...kinds, variables: [] } });

    expect(offered('Variable')).toEqual(['Pick a variable']);
    expect(screen.getByText('Add a variable in the flow’s settings first.')).toBeInTheDocument();
  });

  it('sets up a Publish: the topic, the payload, its QoS and whether the broker keeps it', async () => {
    formOf('publish');

    await userEvent.type(screen.getByLabelText('Topic'), 'plant/k1/cmd');
    await userEvent.type(screen.getByLabelText('Payload'), 'on');
    await userEvent.click(screen.getByRole('radio', { name: 'QoS 1' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Retain' }));

    expect([setting('publish', 'topic'), setting('publish', 'payload')]).toEqual(['plant/k1/cmd', 'on']);
    expect([setting('publish', 'qos'), setting('publish', 'retain')]).toEqual([1, true]);
  });

  it('sets up a Raise alarm: its name, level, reason and the number it records', async () => {
    formOf('alarmRaise');
    const name = screen.getByLabelText('Name');
    const reason = screen.getByLabelText('Reason');

    expect(name).toHaveValue('Boiler too hot');
    expect(screen.getByRole('radio', { name: 'Warn' })).toBeChecked();
    await userEvent.clear(name);
    await userEvent.type(name, 'Kiln too hot');
    await userEvent.click(screen.getByRole('radio', { name: 'Critical' }));
    await userEvent.clear(reason);
    await userEvent.type(reason, 'over the limit');
    await userEvent.type(screen.getByLabelText('Number'), '$.temp');

    expect([setting('alarmRaise', 'name'), setting('alarmRaise', 'level')]).toEqual(['Kiln too hot', 'critical']);
    expect([setting('alarmRaise', 'reason'), setting('alarmRaise', 'value')]).toEqual(['over the limit', '$.temp']);
  });

  // A Raise alarm written into flows.json by hand can come with no level, or one the server does
  // not know. The server says to pick one, and the form must not look as though one were picked.
  it.each([
    ['no level', undefined],
    ['a level the server does not know', 'loud'],
  ])('picks no level for a Raise alarm with %s, and takes the one the reader picks', async (_, level) => {
    const odd = { ...kinds, nodes: kinds.nodes.map((node) => (node.id === 'alarmRaise' ? { ...node, config: { ...node.config, level } } : node)) };
    formOf('alarmRaise', { flow: odd });

    for (const one of ['Info', 'Warn', 'Critical']) expect(screen.getByRole('radio', { name: one })).not.toBeChecked();

    await userEvent.click(screen.getByRole('radio', { name: 'Critical' }));
    expect(setting('alarmRaise', 'level')).toBe('critical');
  });

  // A Clear alarm closes what a Raise alarm opened, so it names one by the name the reader gave it,
  // and keeps that node's id, which a rename leaves standing.
  it('sets up a Clear alarm: which of the flow’s Raise alarms it closes, by name', async () => {
    formOf('alarmClear');

    expect(offered('Alarm')).toEqual(['Pick an alarm', 'Boiler too hot', 'Fan stuck']);
    await userEvent.selectOptions(screen.getByLabelText('Alarm'), 'Fan stuck');

    expect(setting('alarmClear', 'alarm')).toBe('stuck');
  });

  it('sets up a Sound: the level whose tone it plays', async () => {
    formOf('sound');

    expect(screen.getByRole('radio', { name: 'Warn' })).toBeChecked();
    await userEvent.click(screen.getByRole('radio', { name: 'Critical' }));

    expect(setting('sound', 'level')).toBe('critical');
  });

  it('sets up a Notify: the text of its notice and its level', async () => {
    formOf('notify');
    const text = screen.getByLabelText('Text');

    await userEvent.clear(text);
    await userEvent.type(text, 'Boiler k1 is hot');
    await userEvent.click(screen.getByRole('radio', { name: 'Warn' }));

    expect(setting('notify', 'text')).toBe('Boiler k1 is hot');
    expect(setting('notify', 'level')).toBe('warn');
  });

  it('sets up a Webhook: the address it posts to and the body, and says when this host will not send one', async () => {
    formOf('webhook', { allowWebhooks: false });

    await userEvent.type(screen.getByLabelText('Address'), 'https://hooks.example.com/boiler');
    await userEvent.type(screen.getByLabelText('Body'), 'hot');

    expect(setting('webhook', 'url')).toBe('https://hooks.example.com/boiler');
    expect(setting('webhook', 'body')).toBe('hot');
    expect(screen.getByText(/Webhooks are turned off on this host/)).toBeInTheDocument();
  });

  it.each([
    ['start', 'Every run begins here. It has no settings.'],
    ['end', 'A run that gets here is finished.'],
    ['debug', 'Prints every message it is given in Debug, under the canvas.'],
  ])('has nothing to set up on a %s node, and says what it does instead', (id, said) => {
    formOf(id);

    expect(screen.getByText(said)).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});
