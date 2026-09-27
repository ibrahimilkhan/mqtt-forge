import type { ReactElement } from 'react';
import type { FlowNodeStatusDto, FlowNodeType } from '../../types/api';
import { Bell } from '../brand/icons';
import { BranchGlyph, ClockGlyph, DebugGlyph, EachGlyph, InGlyph, PlayGlyph, RepeatGlyph, SendGlyph } from './glyphs';

export type NodeGroup = 'Triggers' | 'Logic' | 'Actions';

/** The palette's three headings, in the order a flow reads: what starts it, what it decides, what it does. */
export const GROUPS: readonly NodeGroup[] = ['Triggers', 'Logic', 'Actions'];

export type NodeSpec = {
  type: FlowNodeType;
  label: string;
  group: NodeGroup;
  /** Under the palette item: what the node is for, in a few words. */
  blurb: string;
  icon: () => ReactElement;
  /** Input ports, top to bottom. The server's FlowPorts.Ins, one for one. */
  ins: readonly string[];
  /** Output ports, top to bottom. The server's FlowPorts.Outs, one for one. */
  outs: readonly string[];
  /** A new node's settings. A function, so no two nodes ever share one object. */
  defaults: () => Record<string, unknown>;
  /** Under the node's name on the canvas: its settings, said briefly. */
  summary: (config: Record<string, unknown>) => string;
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

/** Every placeholder a Publish or an Alarm can fill in, as the inspector lists them. */
export const TEMPLATE_HELP = '{{topic}}  {{topic[1]}}  {{payload}}  {{$.field}}  {{index}}  {{now}}  {{random(80,95)}}';

const text = (value: unknown) =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';

/** A number typed into a box arrives as its text; either is read the way the server reads it. */
const number = (value: unknown) => {
  const read = typeof value === 'number' ? value : Number.parseFloat(text(value));
  return Number.isFinite(read) ? read : 0;
};

const out = (status: FlowNodeStatusDto, key: string) => status.outs[key] ?? 0;

/** The errors, when there were any, at the end of any status line. */
const withErrors = (line: string, status: FlowNodeStatusDto) =>
  status.errors > 0 ? `${line} · ${status.errors} ${status.errors === 1 ? 'error' : 'errors'}` : line;

const testLabel = (test: unknown) => IF_TESTS.find((one) => one.value === test)?.label ?? '?';

export const NODE_SPECS: Record<FlowNodeType, NodeSpec> = {
  mqttIn: {
    type: 'mqttIn',
    label: 'MQTT in',
    group: 'Triggers',
    blurb: 'Every message on a filter',
    icon: InGlyph,
    ins: [],
    outs: ['out'],
    defaults: () => ({ filter: '', replay: false }),
    summary: (config) => text(config.filter) || 'no filter yet',
    status: (status) => withErrors(`${status.count} in`, status),
  },
  every: {
    type: 'every',
    label: 'Every',
    group: 'Triggers',
    blurb: 'A message on a timer',
    icon: ClockGlyph,
    ins: [],
    outs: ['out'],
    defaults: () => ({ seconds: 5, topic: '', payload: '' }),
    summary: (config) => `every ${number(config.seconds)} s`,
    status: (status) => withErrors(`${status.count} ticks`, status),
  },
  inject: {
    type: 'inject',
    label: 'Inject',
    group: 'Triggers',
    blurb: 'A message when you press ▶',
    icon: PlayGlyph,
    ins: [],
    outs: ['out'],
    defaults: () => ({ topic: '', payload: '' }),
    summary: (config) => text(config.topic) || text(config.payload) || 'an empty message',
    status: (status) => withErrors(`${status.count} sent`, status),
  },
  if: {
    type: 'if',
    label: 'If',
    group: 'Logic',
    blurb: 'Yes or no, on a field',
    icon: BranchGlyph,
    ins: ['in'],
    outs: ['yes', 'no'],
    defaults: () => ({ field: '', test: 'gt', value: '', value2: '' }),
    summary: (config) => {
      const field = text(config.field) || 'payload';
      if (config.test === 'exists') return `${field} exists`;
      if (config.test === 'between') return `${field} between ${text(config.value)} and ${text(config.value2)}`;
      return `${field} ${testLabel(config.test)} ${text(config.value)}`.trim();
    },
    status: (status) => {
      const skipped = out(status, 'skipped');
      const line = `yes ${out(status, 'yes')} · no ${out(status, 'no')}${skipped > 0 ? ` · ${skipped} skipped` : ''}`;
      return withErrors(line, status);
    },
  },
  forEach: {
    type: 'forEach',
    label: 'For each',
    group: 'Logic',
    blurb: 'One message per array element',
    icon: EachGlyph,
    ins: ['in'],
    outs: ['out'],
    defaults: () => ({ field: '' }),
    summary: (config) => `each of ${text(config.field) || 'the payload'}`,
    status: (status) => withErrors(`${out(status, 'out')} out`, status),
  },
  repeat: {
    type: 'repeat',
    label: 'Repeat',
    group: 'Logic',
    blurb: 'The same message, again',
    icon: RepeatGlyph,
    ins: ['in'],
    outs: ['out'],
    defaults: () => ({ count: 3, seconds: 1 }),
    summary: (config) => {
      const seconds = number(config.seconds);
      const times = `${number(config.count)} times`;
      return seconds === 0 ? `${times} at once` : `${times}, ${seconds} s apart`;
    },
    status: (status) => withErrors(`${out(status, 'out')} out`, status),
  },
  alarm: {
    type: 'alarm',
    label: 'Alarm',
    group: 'Actions',
    blurb: 'Raise or clear an alarm',
    icon: Bell,
    ins: ['raise', 'clear'],
    outs: [],
    defaults: () => ({
      name: 'Alarm',
      severity: 'warn',
      reason: '{{topic}}',
      value: '',
      sound: false,
      webhook: '',
      publish: false,
      publishTopic: '',
      qos: 1,
      retain: false,
    }),
    summary: (config) => `${text(config.severity) || 'warn'} · ${text(config.name) || 'Alarm'}`,
    status: (status) => withErrors(`${status.standing.length} up · ${out(status, 'raised')} raised`, status),
  },
  publish: {
    type: 'publish',
    label: 'Publish',
    group: 'Actions',
    blurb: 'Send a message',
    icon: SendGlyph,
    ins: ['in'],
    outs: [],
    defaults: () => ({ topic: '', payload: '', qos: 0, retain: false }),
    summary: (config) => text(config.topic) || 'no topic yet',
    status: (status) => withErrors(`${out(status, 'sent')} sent`, status),
  },
  debug: {
    type: 'debug',
    label: 'Debug',
    group: 'Actions',
    blurb: 'Print messages below',
    icon: DebugGlyph,
    ins: ['in'],
    outs: [],
    defaults: () => ({}),
    summary: () => 'prints to Debug',
    status: (status) => withErrors(`${status.count} printed`, status),
  },
};

export const isNodeType = (value: unknown): value is FlowNodeType =>
  typeof value === 'string' && Object.hasOwn(NODE_SPECS, value);
