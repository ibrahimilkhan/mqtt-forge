import type { ReactElement } from 'react';
import type { FlowDto, FlowEdgeDto, FlowNodeDto, FlowNodeStatusDto, FlowNodeType } from '../../types/api';
import { Bell } from '../brand/icons';
import {
  BellOffGlyph,
  BranchGlyph,
  ClockGlyph,
  DebugGlyph,
  EachGlyph,
  HookGlyph,
  InGlyph,
  NoticeGlyph,
  PlayGlyph,
  RepeatGlyph,
  SendGlyph,
  SetGlyph,
  SpeakerGlyph,
  StopGlyph,
  UnknownGlyph,
} from './glyphs';

type NodeGroup = 'Input' | 'Control' | 'Actions' | 'Alarm';

/**
 * The palette's four headings, in the order a flow is read: what it takes in, how it goes, what it
 * does, and the alarm with what is told of it.
 */
export const GROUPS: readonly NodeGroup[] = ['Input', 'Control', 'Actions', 'Alarm'];

/** How a node is drawn: the flowchart's own shapes, so a drawing reads as the diagram it is. */
export type NodeShape = 'terminal' | 'decision' | 'input' | 'loop' | 'step';

/** Which side of its node a port stands on. */
export type Side = 'left' | 'right' | 'top' | 'bottom';

/** A node's ports, as they are wired. */
export type Ports = { ins: readonly string[]; outs: readonly string[] };

/**
 * Where each port stands. A run comes in from the left and goes on to the right, so a flowchart
 * reads left to right; the second way out of a decision or an alarm step goes down, and so does a
 * loop's done, so the main line stays straight; and a loop's next is on top, where its body's last
 * wire comes back over the body to it.
 */
const SIDES: Readonly<Record<string, Side>> = {
  in: 'left',
  next: 'top',
  out: 'right',
  yes: 'right',
  body: 'right',
  raised: 'right',
  cleared: 'right',
  no: 'bottom',
  done: 'bottom',
  up: 'bottom',
  none: 'bottom',
};

/** A port of a type this build does not know stands where its kind usually does: in on the left, out on the right. */
export const sideOf = (port: string, out = true): Side => SIDES[port] ?? (out ? 'right' : 'left');

/** What a port is called on the canvas, when its node has more than one way in or out. */
export const portLabel = (port: string) => (port === 'up' ? 'already up' : port === 'none' ? "wasn't up" : port);

/**
 * What stands beside a port on the canvas: its name, when its node has more than one way in or out
 * (`named`), and `wire me` when it wants a wire (`open`). A node with one way in and one way out has
 * nothing to tell apart, and a way in called in is never named.
 */
export function nameOf(port: string, named: boolean, open: boolean): string {
  const name = named && port !== 'in' ? portLabel(port) : '';
  return open ? (name ? `${name} · wire me` : 'wire me') : name;
}

export const isLoop = (type: string) => type === 'for' || type === 'forEach';

export type NodeSpec = {
  /** The type as flows.json names it. */
  type: string;
  label: string;
  /** Null for a type this build does not know, which belongs to none of the palette's groups. */
  group: NodeGroup | null;
  /** Whether the palette offers it. The Start is never placed: a flow has the one it was made with. */
  placeable: boolean;
  /** Under the palette item: what the node is for, in a few words. */
  blurb: string;
  /** At the top of its pane: what it does and how it is wired, in a sentence or two. */
  help: string;
  icon: () => ReactElement;
  shape: NodeShape;
  /** Ways in. The server's FlowPorts.Ins, one for one. */
  ins: readonly string[];
  /** Ways out. The server's FlowPorts.Outs, one for one. */
  outs: readonly string[];
  /** A new node's settings. A function, so no two nodes ever share one object. */
  defaults: () => Record<string, unknown>;
  /** Under the node's name on the canvas: its settings, said briefly. Some need the flow to say it. */
  summary: (config: Record<string, unknown>, flow: FlowDto) => string;
  /** At the foot of the node: what it has done, from the server's counters. */
  status: (status: FlowNodeStatusDto) => string;
};

/** The tests an If can make, as its select offers them. The server's IfTest names, one for one. */
export const IF_TESTS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'gt', label: '>' },
  { value: 'gte', label: '≥' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '≤' },
  { value: 'eq', label: '=' },
  { value: 'neq', label: '≠' },
  { value: 'between', label: 'between' },
  { value: 'matches', label: 'matches' },
  { value: 'oneOf', label: 'one of' },
  { value: 'exists', label: 'exists' },
];

export const SEVERITIES = [
  { value: 'info', label: 'Info' },
  { value: 'warn', label: 'Warn' },
  { value: 'critical', label: 'Critical' },
] as const;

/** A level the server takes, or null: a hand-edited node with none, or one the server does not know. */
export const levelOf = (value: unknown) => SEVERITIES.find((one) => one.value === value)?.value ?? null;

/** Every placeholder a text can fill in, and what each gives, as the panes list them. */
export const TEMPLATE_HELP: ReadonlyArray<{ placeholder: string; gives: string }> = [
  { placeholder: '{{topic}}', gives: 'the message’s topic' },
  { placeholder: '{{topic[1]}}', gives: 'one level of the topic, counted from 0: plant/k1/temp gives k1' },
  { placeholder: '{{payload}}', gives: 'the message’s payload — in a For each, the element' },
  { placeholder: '{{$.temp}}', gives: 'a field of a JSON payload' },
  { placeholder: '{{var.limit}}', gives: 'one of the flow’s variables' },
  { placeholder: '{{index}}', gives: 'the turn of the loop the message is in, from 1' },
  { placeholder: '{{now}}', gives: 'the time, in UTC' },
  { placeholder: '{{random(80,95)}}', gives: 'a number between the two, with one decimal' },
];

/** A setting as the text a box shows: a number typed in is kept as either. */
export const textOf = (value: unknown) =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';

const out = (status: FlowNodeStatusDto, key: string) => status.outs[key] ?? 0;

/** The errors, and what was let go past a channel's rate, at the end of a status line. */
const withErrors = (line: string, status: FlowNodeStatusDto) => {
  const dropped = out(status, 'dropped');
  const tail = [
    ...(dropped > 0 ? [`${dropped} dropped`] : []),
    ...(status.errors > 0 ? [`${status.errors} ${status.errors === 1 ? 'error' : 'errors'}`] : []),
  ];
  return [line, ...tail].join(' · ');
};

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

const testLabel = (test: unknown) => IF_TESTS.find((one) => one.value === test)?.label ?? '?';

/** A type this build knows: one the palette can offer and the inspector has a form for. */
type KnownSpec = NodeSpec & { type: FlowNodeType };

export const NODE_SPECS: Record<FlowNodeType, KnownSpec> = {
  start: {
    type: 'start',
    label: 'Start',
    group: 'Control',
    placeable: false,
    blurb: 'Where every run begins',
    help: 'Every run begins here: when you press Test, when you Activate the flow, and each time the application starts with the flow switched on.',
    icon: PlayGlyph,
    shape: 'terminal',
    ins: [],
    outs: ['out'],
    defaults: () => ({}),
    summary: () => 'every run begins here',
    status: (status) => withErrors(plural(status.count, 'run'), status),
  },
  mqttIn: {
    type: 'mqttIn',
    label: 'MQTT in',
    group: 'Input',
    placeable: true,
    blurb: 'Waits for the next message',
    help: 'Waits for the next message on its filter, then goes on with it: the run’s topic and payload become that message’s. Messages that come before the run gets here wait in a queue. Inside a forever For, it reads every message.',
    icon: InGlyph,
    shape: 'input',
    ins: ['in'],
    outs: ['out'],
    defaults: () => ({ filter: '', replay: false }),
    summary: (config) => textOf(config.filter) || 'no filter yet',
    status: (status) => withErrors(`${out(status, 'out')} read`, status),
  },
  if: {
    type: 'if',
    label: 'If',
    group: 'Control',
    placeable: true,
    blurb: 'Yes or no',
    help: 'Asks one question of a field of the message or of a variable, and goes yes or no. A field the message does not carry is a no.',
    icon: BranchGlyph,
    shape: 'decision',
    ins: ['in'],
    outs: ['yes', 'no'],
    defaults: () => ({ field: '', test: 'gt', value: '', value2: '' }),
    summary: (config) => {
      const field = textOf(config.field) || 'payload';
      if (config.test === 'exists') return `${field} exists`;
      if (config.test === 'between') return `${field} between ${textOf(config.value)} and ${textOf(config.value2)}`;
      return `${field} ${testLabel(config.test)} ${textOf(config.value)}`.trim();
    },
    status: (status) => withErrors(`yes ${out(status, 'yes')} · no ${out(status, 'no')}`, status),
  },
  for: {
    type: 'for',
    label: 'For',
    group: 'Control',
    placeable: true,
    blurb: 'Its body N times, or forever',
    help: 'Runs its body one turn after another: body goes to the first step, and the last step is wired back to next. done goes on after the last turn, and {{index}} is the turn, from 1. A forever loop needs a Wait or an MQTT in in its body.',
    icon: RepeatGlyph,
    shape: 'loop',
    ins: ['in', 'next'],
    outs: ['body', 'done'],
    defaults: () => ({ times: '3', forever: false }),
    summary: (config) => (config.forever === true ? 'forever' : `${textOf(config.times) || '?'} times`),
    status: (status) => withErrors(plural(out(status, 'body'), 'turn'), status),
  },
  forEach: {
    type: 'forEach',
    label: 'For each',
    group: 'Control',
    placeable: true,
    blurb: 'Its body once per element',
    help: 'Runs its body once for each element of an array, one turn after another; in each turn the payload is the element. done goes on with the message as it came in.',
    icon: EachGlyph,
    shape: 'loop',
    ins: ['in', 'next'],
    outs: ['body', 'done'],
    defaults: () => ({ array: '' }),
    summary: (config) => `each of ${textOf(config.array) || 'the payload'}`,
    status: (status) => withErrors(plural(out(status, 'body'), 'turn'), status),
  },
  wait: {
    type: 'wait',
    label: 'Wait',
    group: 'Control',
    placeable: true,
    blurb: 'Pauses the run',
    help: 'Holds the run for some seconds, then goes on. In a loop’s body it spaces the turns.',
    icon: ClockGlyph,
    shape: 'step',
    ins: ['in'],
    outs: ['out'],
    defaults: () => ({ seconds: '1' }),
    summary: (config) => `${textOf(config.seconds) || '?'} s`,
    status: (status) => withErrors(`${out(status, 'out')} waited`, status),
  },
  set: {
    type: 'set',
    label: 'Set',
    group: 'Control',
    placeable: true,
    blurb: 'Gives a variable a value',
    help: 'Gives one of the flow’s variables a value — something typed, or {{…}} from the message — that the rest of the run reads as {{var.name}}.',
    icon: SetGlyph,
    shape: 'step',
    ins: ['in'],
    outs: ['out'],
    defaults: () => ({ variable: '', value: '' }),
    summary: (config) => (textOf(config.variable) ? `${textOf(config.variable)} = ${textOf(config.value)}` : 'no variable picked'),
    status: (status) => withErrors(`${out(status, 'out')} set`, status),
  },
  end: {
    type: 'end',
    label: 'End',
    group: 'Control',
    placeable: true,
    blurb: 'The run ends here',
    help: 'A run that reaches an End is finished. A flow can have as many Ends as its drawing needs.',
    icon: StopGlyph,
    shape: 'terminal',
    ins: ['in'],
    outs: [],
    defaults: () => ({}),
    summary: () => 'the run ends',
    status: (status) => withErrors(`${status.count} ended`, status),
  },
  publish: {
    type: 'publish',
    label: 'Publish',
    group: 'Actions',
    placeable: true,
    blurb: 'Sends a message',
    help: 'Publishes a message to the broker and goes on. The topic and payload can fill in {{…}} from the message and the variables.',
    icon: SendGlyph,
    shape: 'step',
    ins: ['in'],
    outs: ['out'],
    defaults: () => ({ topic: '', payload: '', qos: 0, retain: false }),
    summary: (config) => textOf(config.topic) || 'no topic yet',
    status: (status) => withErrors(`${out(status, 'sent')} sent`, status),
  },
  debug: {
    type: 'debug',
    label: 'Debug',
    group: 'Actions',
    placeable: true,
    blurb: 'Prints the message below',
    help: 'Prints the message in the Debug strip under the canvas, and goes on.',
    icon: DebugGlyph,
    shape: 'step',
    ins: ['in'],
    outs: ['out'],
    defaults: () => ({}),
    summary: () => 'prints to Debug',
    status: (status) => withErrors(`${status.count} printed`, status),
  },
  alarmRaise: {
    type: 'alarmRaise',
    label: 'Raise alarm',
    group: 'Alarm',
    placeable: true,
    blurb: 'Opens an alarm',
    help: 'Opens an alarm in the Alerts panel for the message’s topic. It goes raised when the alarm is new, and already up while that alarm stays open — so a Sound or a Notify after raised happens once an alarm, not once a message.',
    icon: Bell,
    shape: 'step',
    ins: ['in'],
    outs: ['raised', 'up'],
    defaults: () => ({ name: 'Alarm', level: 'warn', reason: '{{topic}}', value: '' }),
    summary: (config) => `${levelOf(config.level) ?? 'no level'} · ${textOf(config.name) || 'Alarm'}`,
    status: (status) => withErrors(`${status.standing.length} up · ${out(status, 'raised')} raised`, status),
  },
  alarmClear: {
    type: 'alarmClear',
    label: 'Clear alarm',
    group: 'Alarm',
    placeable: true,
    blurb: 'Closes an alarm',
    help: 'Closes the alarm a Raise alarm opened for the message’s topic. It goes cleared when there was one open, and wasn’t up when there was not.',
    icon: BellOffGlyph,
    shape: 'step',
    ins: ['in'],
    outs: ['cleared', 'none'],
    defaults: () => ({ alarm: '' }),
    summary: (config, flow) => {
      const raise = flow.nodes.find((node) => node.id === config.alarm && node.type === 'alarmRaise');
      return raise ? `closes ${textOf(raise.config.name) || 'Alarm'}` : 'no alarm picked';
    },
    status: (status) => withErrors(`${out(status, 'cleared')} cleared`, status),
  },
  sound: {
    type: 'sound',
    label: 'Sound',
    group: 'Alarm',
    placeable: true,
    blurb: 'A tone in open consoles',
    help: 'Plays the alarm tone at its level in every open console — one beep for info, two for warn, three for critical — and goes on. Nobody hears it when no console is open; use Webhook or Publish for that.',
    icon: SpeakerGlyph,
    shape: 'step',
    ins: ['in'],
    outs: ['out'],
    defaults: () => ({ level: 'warn' }),
    summary: (config) => `${levelOf(config.level) ?? 'no level'} tone`,
    status: (status) => withErrors(`${out(status, 'played')} played`, status),
  },
  notify: {
    type: 'notify',
    label: 'Notify',
    group: 'Alarm',
    placeable: true,
    blurb: 'A notice in open consoles',
    help: 'Shows a notice for eight seconds in the corner of every open console, and goes on. The text can fill in {{…}}.',
    icon: NoticeGlyph,
    shape: 'step',
    ins: ['in'],
    outs: ['out'],
    defaults: () => ({ text: '{{topic}}', level: 'info' }),
    summary: (config) => textOf(config.text) || 'no text yet',
    status: (status) => withErrors(`${out(status, 'shown')} shown`, status),
  },
  webhook: {
    type: 'webhook',
    label: 'Webhook',
    group: 'Alarm',
    placeable: true,
    blurb: 'Posts to an address',
    help: 'Posts its body to an http or https address and goes on; the post is made in the background, and one that never lands is counted on the node. An empty body sends the message as it is.',
    icon: HookGlyph,
    shape: 'step',
    ins: ['in'],
    outs: ['out'],
    defaults: () => ({ url: '', body: '' }),
    summary: (config) => textOf(config.url) || 'no address yet',
    status: (status) => withErrors(`${out(status, 'posted')} posted`, status),
  },
};

export const isNodeType = (value: unknown): value is FlowNodeType =>
  typeof value === 'string' && Object.hasOwn(NODE_SPECS, value);

/**
 * What a node of this type is, for anything that draws or names one.
 *
 * The server keeps a flow a newer build wrote and hands it back, so a node can be of a type this
 * build has never heard of — or of one an older build had and this one has given up, as Inject,
 * Every, Repeat and the old Alarm were. It is named by that type, with a mark that says it is not
 * understood, and has no ports of its own: the server refuses every wire to or from it, so no new
 * one can be drawn (the wires the flow already has still meet it — see portsOf). Everything else
 * about the flow — its other nodes, deleting it, taking the node out so the rest can run — goes on
 * working.
 */
export function specOf(type: string): NodeSpec {
  if (isNodeType(type)) return NODE_SPECS[type];

  return {
    type,
    label: type,
    group: null,
    placeable: false,
    blurb: 'Not known to this build',
    help: 'This build does not know this kind of node. Its settings are kept as they are, and the flow will not run until it is taken out.',
    icon: UnknownGlyph,
    shape: 'step',
    ins: [],
    outs: [],
    defaults: () => ({}),
    summary: () => 'not known to this build',
    status: (status) => withErrors(`${status.count} in`, status),
  };
}

/**
 * The ports a node is drawn with: its type's, or — for a type this build does not know, which has
 * none here — the ones its wires name, so the wires the flow already has still meet it and can be
 * seen, and picked, and read about. No new wire can be drawn to them: canConnect asks specOf.
 */
export function portsOf(node: FlowNodeDto, edges: readonly FlowEdgeDto[]): Ports {
  if (isNodeType(node.type)) return NODE_SPECS[node.type];

  const once = (ports: string[]) => [...new Set(ports)];
  return {
    ins: once(edges.filter((edge) => edge.to === node.id).map((edge) => edge.toPort)),
    outs: once(edges.filter((edge) => edge.from === node.id).map((edge) => edge.fromPort)),
  };
}
