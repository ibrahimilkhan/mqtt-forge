import { act, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Profiler } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFlowStatusStore } from '../../stores/flowStatusStore';
import { server } from '../../test/server';
import { renderWithClient as render } from '../../test/renderWithClient';
import type { FlowDebugDto, FlowDto, FlowNodeType, FlowRunStatusDto, FlowStatusDto } from '../../types/api';
import { exampleFlows } from './examples';
import canvasSheet from './FlowCanvas.module.css?raw';
import { useFlowDraftStore } from './flowDraftStore';
import { Inspector } from './Inspector';
import sheet from './Inspector.module.css?raw';
import { GROUPS, NODE_SPECS, TEMPLATE_HELP } from './nodeTypes';
import { Palette } from './Palette';
import paletteSheet from './Palette.module.css?raw';
import { forgetDrafts, runOf, withoutComments } from './canvasTestbed';

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

function Inspecting() {
  const flow = useFlowDraftStore((state) => state.drafts.watch) ?? watch;
  return <Inspector flow={flow} deployed={watch} overtaken={false} problems={{}} facts={facts} />;
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

/**
 * The inspector on a flow, as the page draws it: on the flow's draft once it has one, beside
 * `deployed`, the copy the server has — undefined for a flow it does not have — and `overtaken`
 * when the draft was started from a copy the server has since replaced or deleted.
 */
function Drawn({
  flow,
  deployed,
  overtaken = false,
  allowWebhooks = true,
}: {
  flow: FlowDto;
  deployed: FlowDto | undefined;
  overtaken?: boolean;
  allowWebhooks?: boolean;
}) {
  const shownFlow = useFlowDraftStore((state) => state.drafts[flow.id]) ?? flow;
  return (
    <Inspector flow={shownFlow} deployed={deployed} overtaken={overtaken} problems={{}} facts={{ ...facts, allowWebhooks }} />
  );
}

/** The pane of one node, picked as a click on the canvas picks it. */
const formOf = (nodeId: string, { flow = kinds, allowWebhooks = true }: { flow?: FlowDto; allowWebhooks?: boolean } = {}) => {
  useFlowDraftStore.getState().select(nodeId);
  render(<Drawn flow={flow} deployed={flow} allowWebhooks={allowWebhooks} />);
};

/**
 * The example Boiler watch — a whole flowchart, with the variable its If reads — under the id the
 * watch above has, so its draft and its runs are the watch's.
 */
const example: FlowDto = { ...exampleFlows()[1], id: 'watch' };

/**
 * The inspector on a flow, with `selected` picked if it says one. The server's copy is the flow
 * itself unless `deployed` says another, or — given as undefined — that the server has none, and
 * the draft is its own unless `overtaken` says the server has moved on since it was started.
 */
function drawInspector(flow: FlowDto, options: { deployed?: FlowDto; selected?: string; overtaken?: boolean } = {}) {
  if (options.selected !== undefined) useFlowDraftStore.getState().select(options.selected);
  return render(<Drawn flow={flow} deployed={'deployed' in options ? options.deployed : flow} overtaken={options.overtaken} />);
}

/** The watch's draft, which the first edit in its pane makes. */
const draft = () => useFlowDraftStore.getState().drafts.watch!;

/** A status push with one run of a flow in it: active and waiting, at no node, unless `over` says otherwise. */
const run = (flowId: string, over: Partial<FlowRunStatusDto>): FlowStatusDto => ({ runs: [runOf(flowId, over)] });

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

  // A reader who points at an item before putting it down reads what the node does, in the words its
  // pane opens with once it is down.
  it('says what each node does on its item, in the words of its pane', () => {
    render(<Palette onAdd={() => {}} />);

    expect(screen.getAllByRole('button').map((item) => item.getAttribute('title'))).toEqual(
      GROUPS.flatMap((group) =>
        Object.values(NODE_SPECS)
          .filter((spec) => spec.group === group && spec.placeable)
          .map((spec) => spec.help),
      ),
    );
  });

  // A node wears its group's colour on the canvas, and its item the same one here: the colour is how
  // a reader finds on the canvas what they put down from the palette.
  it('colours each group as the canvas colours its nodes', () => {
    const colourOf = (stylesheet: string, element: string, group: string) =>
      new RegExp(String.raw`\.${element}\[data-group='${group}'\] \.icon \{ color: ([^;]+); \}`).exec(
        withoutComments(stylesheet),
      )?.[1];

    for (const group of GROUPS) {
      expect(colourOf(paletteSheet, 'item', group), group).toBeDefined();
      expect(colourOf(paletteSheet, 'item', group), group).toBe(colourOf(canvasSheet, 'node', group));
    }
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
    expect(screen.getByText('Active · not running')).toBeInTheDocument();
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
    render(<Inspector flow={twice} deployed={twice} overtaken={false} problems={{ 'edge:e1': ['Not this wire.'] }} facts={facts} />);

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
    render(<Inspector flow={told} deployed={told} overtaken={false} problems={{ 'edge:e1': ['Not this wire.'] }} facts={facts} />);

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
    // Its draft goes with it: kept, it would bring the flow back with the next Activate.
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

  // The flow pane takes whatever is typed into a variable's name: nothing there says a name is
  // taken or empty until the server is asked. So a flow can have two variables of one name and one
  // with none, and a Set offers each name once and no empty one — an option for every variable
  // would offer the same name twice, and a choice that picks nothing.
  describe('for a Set in a flow whose variables share a name or have none', () => {
    const odd: FlowDto = {
      ...kinds,
      variables: [
        { name: 'limit', value: '90' },
        { name: 'limit', value: '95' },
        { name: '', value: '' },
      ],
    };

    afterEach(() => vi.restoreAllMocks());

    it('offers each name once, and no empty one', () => {
      formOf('set', { flow: odd });

      expect(offered('Variable')).toEqual(['Pick a variable', 'limit']);
    });

    // Two options of one key are two siblings React cannot tell apart, and it says so in the console.
    it('does not hand React two options of one key', () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

      formOf('set', { flow: odd });

      expect(errors.mock.calls.filter(([message]) => /same key/.test(String(message)))).toEqual([]);
    });

    // With nothing named there is nothing to pick. There are variables, though, and the hint under the
    // box says what they want: a name, not another variable.
    it('says to name a variable when none of them has a name', () => {
      formOf('set', { flow: { ...kinds, variables: [{ name: '', value: '' }] } });

      expect(offered('Variable')).toEqual(['Pick a variable']);
      expect(screen.getByText('Name a variable in the flow’s settings first.')).toBeInTheDocument();
      expect(screen.queryByText('Add a variable in the flow’s settings first.')).not.toBeInTheDocument();
    });
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

  // Every pane says what its node does over the form, so the form of a node with nothing to set
  // says only that: a second sentence about what it does would be the first one again.
  it.each(['start', 'end', 'debug'] as const)('has nothing to set up on a %s node, and says so under what it does', (id) => {
    formOf(id);

    expect(screen.getByText(NODE_SPECS[id].help)).toBeInTheDocument();
    expect(screen.getByText('It has no settings.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});

describe('the flow pane', () => {
  it('edits the variables a run starts with', async () => {
    drawInspector({ ...example, variables: [{ name: 'limit', value: '90' }] });

    fireEvent.change(screen.getByLabelText('Value of limit'), { target: { value: '95' } });
    expect(draft().variables).toEqual([{ name: 'limit', value: '95' }]);

    fireEvent.click(screen.getByRole('button', { name: 'Add variable' }));
    expect(draft().variables).toEqual([{ name: 'limit', value: '95' }, { name: 'v1', value: '' }]);

    fireEvent.click(screen.getByRole('button', { name: 'Remove limit' }));
    expect(draft().variables).toEqual([{ name: 'v1', value: '' }]);
  });

  // A row keyed by the name it shows would be a new row at every letter typed into that name, and
  // the box being typed into would lose the keyboard after the first.
  it('keeps the keyboard in a name being typed', async () => {
    drawInspector({ ...example, variables: [{ name: 'limit', value: '90' }] });

    await userEvent.type(screen.getByLabelText('Name of variable 1'), '_max');

    expect(draft().variables).toEqual([{ name: 'limit_max', value: '90' }]);
    expect(screen.getByLabelText('Name of variable 1')).toHaveFocus();
  });

  it('names a new variable v1, v2 … by the first a flow has no variable called', () => {
    drawInspector({ ...example, variables: [{ name: 'v1', value: '' }, { name: 'v3', value: '' }] });

    fireEvent.click(screen.getByRole('button', { name: 'Add variable' }));

    expect(draft().variables.map((variable) => variable.name)).toEqual(['v1', 'v3', 'v2']);
  });

  // The row goes with the button that took it away, and a browser hands the keyboard of a button
  // taken out to the body. Add variable is under where the row was.
  it('hands the keyboard to Add variable when the last row goes', async () => {
    drawInspector({ ...example, variables: [{ name: 'limit', value: '90' }] });

    await userEvent.click(screen.getByRole('button', { name: 'Remove limit' }));

    expect(draft().variables).toEqual([]);
    expect(screen.getByRole('button', { name: 'Add variable' })).toHaveFocus();
  });

  it('shows what a variable holds now beside its starting value while a run is going', () => {
    useFlowStatusStore.getState().setStatus(run('watch', { kind: 'active', state: 'running', at: 'read', variables: { limit: '95' } }));
    drawInspector({ ...example, variables: [{ name: 'limit', value: '90' }] });

    expect(screen.getByText('now 95')).toBeInTheDocument();
  });

  // jsdom lays nothing out, so this reads the rules. In a browser, beside the two boxes in a pane
  // some 270 pixels across, a list of three keys squeezed them to nothing.
  it('puts what a variable holds now under its value, where a long one cannot squeeze the boxes', () => {
    useFlowStatusStore.getState().setStatus(run('watch', { state: 'running', variables: { sensors: '["k1","k2","k3"]' } }));
    drawInspector({ ...example, variables: [{ name: 'sensors', value: '["k1"]' }] });

    const now = screen.getByText('now ["k1","k2","k3"]');
    expect(now.parentElement?.lastElementChild).toBe(now);
    expect(withoutComments(sheet)).toMatch(/\.variable\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1\.4fr\) auto;/);
    expect(withoutComments(sheet)).toMatch(/\.now\s*\{[^}]*grid-column:\s*2 \/ -1;[^}]*overflow-wrap:\s*anywhere/);
  });

  // A finished run's variables hold what they ended with, which is not what anything holds now. And
  // a name is any name the server takes, constructor among them, which every object answers to.
  it('says what a variable holds now only while the run goes, and only of one the run has', () => {
    const variables = [
      { name: 'limit', value: '90' },
      { name: 'constructor', value: '1' },
    ];
    useFlowStatusStore.getState().setStatus(run('watch', { state: 'finished', variables: { limit: '95' } }));
    drawInspector({ ...example, variables });
    expect(screen.queryByText(/^now /)).not.toBeInTheDocument();

    act(() => useFlowStatusStore.getState().setStatus(run('watch', { state: 'running', variables: { limit: '95' } })));
    expect(screen.getAllByText(/^now /).map((now) => now.textContent)).toEqual(['now 95']);
  });

  // Pushes come up to four times a second, each with every run as a new object, and the nodes'
  // numbers in it move with every message. The pane draws none of those numbers.
  it('draws nothing again for a push that moved nothing it shows', () => {
    const push = (count: number, limit: string) =>
      run('watch', {
        state: 'running',
        at: 'read',
        variables: { limit },
        nodes: [{ id: 'read', count, outs: { out: count }, errors: 0, note: null, standing: [] }],
      });
    useFlowStatusStore.getState().setStatus(push(1, '95'));
    let drawn = 0;
    render(
      <Profiler id="pane" onRender={() => drawn++}>
        <Drawn flow={example} deployed={example} />
      </Profiler>,
    );

    drawn = 0;
    act(() => useFlowStatusStore.getState().setStatus(push(2, '95')));
    expect(drawn).toBe(0);

    act(() => useFlowStatusStore.getState().setStatus(push(3, '96')));
    expect(screen.getByText('now 96')).toBeInTheDocument();
  });

  // A test waits for the reader, who pressed it and is there to send it a message from Publish.
  it('says where the shown run is and what it waits for', () => {
    useFlowStatusStore.getState().setStatus(
      run('watch', { kind: 'test', state: 'waiting', at: 'read', waiting: { until: null, filter: 'plant/+/temp' } }),
    );
    drawInspector(example);

    expect(screen.getByText('Test · waiting for a message on plant/+/temp — send one from Publish')).toBeInTheDocument();
  });

  it('says a flow the server has switched off is off', () => {
    drawInspector({ ...example, enabled: false }, { deployed: { ...example, enabled: false } });

    expect(screen.getByText('Off')).toBeInTheDocument();
  });

  it.each<[string, FlowRunStatusDto | null, FlowDto | undefined, string]>([
    ['a flow switched on with no run', null, { ...example, enabled: true }, 'Active · not running'],
    ['a flow the server does not have', null, undefined, 'Not saved yet'],
    ['a test going, by the node it is at', runOf('watch', { kind: 'test', state: 'running', at: 'test' }), example, 'Test · running at If'],
    ['a run at a node the drawing no longer has', runOf('watch', { state: 'running', at: 'gone' }), example, 'Active · running'],
    ['a test that reached an End', runOf('watch', { kind: 'test', state: 'finished', at: 'end' }), example, 'Test · finished at End'],
    ['a run stopped', runOf('watch', { state: 'stopped' }), example, 'Active · stopped'],
    // The flow at work waits for the plant's own traffic. "Send one from Publish" there would read
    // as advice to put a message into production, so only a test is told it.
    [
      'the active run waiting for a message',
      runOf('watch', { state: 'waiting', at: 'read', waiting: { until: null, filter: 'plant/+/temp' } }),
      example,
      'Active · waiting for a message on plant/+/temp',
    ],
  ])('says, of %s, where it is in one line', (_, shown, deployed, line) => {
    if (shown) useFlowStatusStore.getState().setStatus({ runs: [shown] });
    drawInspector(example, { deployed });

    expect(screen.getByText(line)).toBeInTheDocument();
  });

  // The box over the pane says another console deleted the flow since this draft was started, and
  // "Not saved yet" under it would say the flow was never on the server.
  it('says a flow another console deleted is not on the server, not that it is not saved yet', () => {
    drawInspector(example, { deployed: undefined, overtaken: true });

    expect(screen.getByText('Not on the server')).toBeInTheDocument();
    expect(screen.queryByText('Not saved yet')).not.toBeInTheDocument();
  });

  // Changed is not deleted: the server still has the flow, and the line says how it has it.
  it('says how the server has a flow another console changed, not that it is gone', () => {
    drawInspector(example, { deployed: { ...example, enabled: false }, overtaken: true });

    expect(screen.getByText('Off')).toBeInTheDocument();
    expect(screen.queryByText('Not on the server')).not.toBeInTheDocument();
  });

  it('no longer has Run it once deployed', () => {
    drawInspector(example);

    expect(screen.queryByText('Run it once deployed')).toBeNull();
  });

  // What deleting does depends on how the server has the flow, and the question says which: what
  // becomes of its run, of the server's copy, of the drawing here.
  it.each<[string, FlowDto | undefined, boolean, string]>([
    ['switched on', { ...watch, enabled: true }, false, 'Delete Boiler watch? It stops running, and the server forgets it.'],
    ['switched off', { ...watch, enabled: false }, false, 'Delete Boiler watch? The server forgets it.'],
    ['never saved', undefined, false, 'Drop Boiler watch? It was never saved, and the drawing goes with it.'],
    ['deleted on another console', undefined, true, 'Drop Boiler watch? It is no longer on the server, and your changes go with it.'],
  ])('asks before deleting a flow %s, saying what deleting it does', async (_, deployed, overtaken, question) => {
    drawInspector(watch, { deployed, overtaken });

    await userEvent.click(screen.getByRole('button', { name: 'Delete flow' }));

    expect(screen.getByText(question)).toBeInTheDocument();
  });

  // The delete is what stops a test of the flow: once the flow is gone, nothing is left to press Stop on.
  it('says a test going stops with the flow', async () => {
    useFlowStatusStore.getState().setStatus(run('watch', { kind: 'test', state: 'running' }));
    drawInspector(watch, { deployed: undefined });

    await userEvent.click(screen.getByRole('button', { name: 'Delete flow' }));

    expect(screen.getByText('Drop Boiler watch? It was never saved, and the drawing goes with it. Its test stops.')).toBeInTheDocument();
  });

  // Named as the flow is named everywhere else: a flow with no name read "Delete ? It stops running."
  it('names a flow with no name Untitled in the question', async () => {
    const unnamed = { ...watch, name: '  ' };
    drawInspector(unnamed, { deployed: { ...unnamed, enabled: true } });

    await userEvent.click(screen.getByRole('button', { name: 'Delete flow' }));

    expect(screen.getByText('Delete Untitled? It stops running, and the server forgets it.')).toBeInTheDocument();
  });
});

describe('the flow pane on a run that waits for a time', () => {
  afterEach(() => vi.useRealTimers());

  /** A test of the watch, waiting until this many milliseconds from now. */
  const waitingFor = (ms: number) =>
    run('watch', { kind: 'test', state: 'waiting', waiting: { until: new Date(Date.now() + ms).toISOString(), filter: null } });

  // As the node counts it on the canvas: a tenth at a time, and no further than none left, which it
  // goes on saying until a push says where the run went — ticking on would draw the same line ten
  // times a second.
  it('counts down the seconds it has left, and stops at none', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    useFlowStatusStore.getState().setStatus(waitingFor(2_000));
    let drawn = 0;
    render(
      <Profiler id="pane" onRender={() => drawn++}>
        <Drawn flow={example} deployed={example} />
      </Profiler>,
    );

    expect(screen.getByText(/^Test · Wait (2\.0|1\.9) s$/)).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(screen.getByText(/^Test · Wait (1\.0|0\.9) s$/)).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTime(1_500));
    expect(screen.getByText('Test · Wait 0.0 s')).toBeInTheDocument();

    drawn = 0;
    for (let tenth = 0; tenth < 10; tenth++) await act(async () => vi.advanceTimersByTime(100));

    expect(drawn).toBe(0);
  });

  // The pane has drawn nothing for a while — nothing on it was counting — when the run comes to a
  // Wait. The seconds are counted from then, not from when the pane last looked at the clock.
  it('counts a wait from when it comes, however long the pane has been open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    useFlowStatusStore.getState().setStatus(run('watch', { kind: 'test', state: 'running', at: 'read' }));
    drawInspector(example);
    expect(screen.getByText('Test · running at MQTT in')).toBeInTheDocument();

    await act(async () => vi.advanceTimersByTime(60_000));
    act(() => useFlowStatusStore.getState().setStatus(waitingFor(2_000)));

    expect(screen.getByText(/^Test · Wait (2\.0|1\.9) s$/)).toBeInTheDocument();
  });
});

describe("a node's pane", () => {
  it('says what the node does, and what its texts can fill in', () => {
    drawInspector(example, { selected: 'fan' });

    expect(screen.getByText(NODE_SPECS.publish.help)).toBeInTheDocument();
    expect(screen.getByText('{{var.limit}}')).toBeInTheDocument();
  });

  // What is typed into these can hold {{…}}: an If's values, a For's times, a Wait's seconds, a
  // Set's value, and the texts the actions send. Nothing else a node is set up with can.
  it('lists every placeholder beside what it gives under the forms that fill them in, and under no other', () => {
    const listing = (Object.keys(NODE_SPECS) as FlowNodeType[]).filter((type) => {
      useFlowDraftStore.getState().select(type);
      const { unmount } = render(<Drawn flow={kinds} deployed={kinds} />);
      const list = screen.queryByRole('region', { name: 'Fills in' });
      if (list)
        expect(within(list).getAllByRole('term').map((term) => [term.textContent, term.nextElementSibling?.textContent])).toEqual(
          TEMPLATE_HELP.map((one) => [one.placeholder, one.gives]),
        );
      unmount();
      return list !== null;
    });

    expect(listing).toEqual(['if', 'for', 'wait', 'set', 'publish', 'alarmRaise', 'notify', 'webhook']);
  });

  it('offers no Remove node for the Start', () => {
    drawInspector(example, { selected: 'start' });

    expect(screen.queryByRole('button', { name: 'Remove node' })).toBeNull();
  });
});
