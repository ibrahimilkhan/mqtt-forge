import type { FlowDto } from '../../types/api';
import { newId } from './flowDocument';

/**
 * The two flows "Start from an example" makes: a simulator that publishes three boilers'
 * temperatures every two seconds, and a watch that raises an alarm, sounds it, says it and turns a
 * fan on when one runs hot. Together they need no device — Activate both and the rail's alarm badge
 * lights within seconds — and between them they draw every kind of node but Set and Webhook, each
 * as the flowchart a reader would draw by hand.
 *
 * Real-world on purpose: a plant, boilers, a fan command. `foo/bar` teaches nothing.
 */
export function exampleFlows(): FlowDto[] {
  const simulator: FlowDto = {
    id: newId('f'),
    name: 'Boiler simulator',
    enabled: false,
    variables: [{ name: 'sensors', value: '["k1","k2","k3"]' }],
    nodes: [
      { id: 'start', type: 'start', x: 40, y: 160, config: {} },
      { id: 'loop', type: 'for', x: 240, y: 160, config: { times: '', forever: true } },
      { id: 'each', type: 'forEach', x: 480, y: 160, config: { array: 'var.sensors' } },
      {
        id: 'send',
        type: 'publish',
        x: 720,
        y: 160,
        config: { topic: 'plant/{{payload}}/temp', payload: '{"temp": {{random(80,95)}}}', qos: 0, retain: false },
      },
      { id: 'tick', type: 'wait', x: 480, y: 340, config: { seconds: '2' } },
      { id: 'end', type: 'end', x: 240, y: 340, config: {} },
    ],
    edges: [
      { id: 'e1', from: 'start', fromPort: 'out', to: 'loop', toPort: 'in' },
      { id: 'e2', from: 'loop', fromPort: 'body', to: 'each', toPort: 'in' },
      { id: 'e3', from: 'each', fromPort: 'body', to: 'send', toPort: 'in' },
      { id: 'e4', from: 'send', fromPort: 'out', to: 'each', toPort: 'next' },
      { id: 'e5', from: 'each', fromPort: 'done', to: 'tick', toPort: 'in' },
      { id: 'e6', from: 'tick', fromPort: 'out', to: 'loop', toPort: 'next' },
      { id: 'e7', from: 'loop', fromPort: 'done', to: 'end', toPort: 'in' },
    ],
  };

  const watch: FlowDto = {
    id: newId('f'),
    name: 'Boiler watch',
    enabled: false,
    variables: [{ name: 'limit', value: '90' }],
    nodes: [
      { id: 'start', type: 'start', x: 40, y: 220, config: {} },
      { id: 'loop', type: 'for', x: 220, y: 220, config: { times: '', forever: true } },
      { id: 'read', type: 'mqttIn', x: 440, y: 220, config: { filter: 'plant/+/temp', replay: false } },
      { id: 'say', type: 'debug', x: 660, y: 220, config: {} },
      { id: 'test', type: 'if', x: 880, y: 220, config: { field: '$.temp', test: 'gt', value: '{{var.limit}}', value2: '' } },
      {
        id: 'hot',
        type: 'alarmRaise',
        x: 1100,
        y: 100,
        config: { name: 'Boiler too hot', level: 'warn', reason: '{{topic[1]}} is at {{$.temp}} °C', value: '$.temp' },
      },
      { id: 'beep', type: 'sound', x: 1320, y: 40, config: { level: 'warn' } },
      { id: 'tell', type: 'notify', x: 1540, y: 40, config: { text: '{{topic[1]}} is at {{$.temp}} °C', level: 'warn' } },
      {
        id: 'fan',
        type: 'publish',
        x: 1760,
        y: 40,
        config: { topic: 'plant/{{topic[1]}}/cmd', payload: '{"fan":"on"}', qos: 1, retain: false },
      },
      { id: 'cool', type: 'alarmClear', x: 1100, y: 380, config: { alarm: 'hot' } },
      { id: 'end', type: 'end', x: 220, y: 440, config: {} },
    ],
    edges: [
      { id: 'e1', from: 'start', fromPort: 'out', to: 'loop', toPort: 'in' },
      { id: 'e2', from: 'loop', fromPort: 'body', to: 'read', toPort: 'in' },
      { id: 'e3', from: 'read', fromPort: 'out', to: 'say', toPort: 'in' },
      { id: 'e4', from: 'say', fromPort: 'out', to: 'test', toPort: 'in' },
      { id: 'e5', from: 'test', fromPort: 'yes', to: 'hot', toPort: 'in' },
      { id: 'e6', from: 'hot', fromPort: 'raised', to: 'beep', toPort: 'in' },
      { id: 'e7', from: 'beep', fromPort: 'out', to: 'tell', toPort: 'in' },
      { id: 'e8', from: 'tell', fromPort: 'out', to: 'fan', toPort: 'in' },
      { id: 'e9', from: 'fan', fromPort: 'out', to: 'loop', toPort: 'next' },
      { id: 'e10', from: 'hot', fromPort: 'up', to: 'loop', toPort: 'next' },
      { id: 'e11', from: 'test', fromPort: 'no', to: 'cool', toPort: 'in' },
      { id: 'e12', from: 'cool', fromPort: 'cleared', to: 'loop', toPort: 'next' },
      { id: 'e13', from: 'cool', fromPort: 'none', to: 'loop', toPort: 'next' },
      { id: 'e14', from: 'loop', fromPort: 'done', to: 'end', toPort: 'in' },
    ],
  };

  return [simulator, watch];
}
