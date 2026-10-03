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
 *
 * Laid out for the shapes the canvas draws. Along a row, one node's right edge stands 96 from the
 * next one's left, room for a way out's name beside its port — steps NODE_WIDTH + 96 = 284 apart, and
 * the If, DECISION_WIDTH across, 64 more. A node's ports stand at half its height, so the If,
 * DECISION_HEIGHT tall, stands 28 higher than the steps beside it, and every wire along a row runs
 * level. A way out at the foot of a node — a loop's done, the If's no — leads down to a row of its
 * own, far enough under it that the port's name clears what stands there.
 *
 * And for the way a wire going back is drawn (backWires.ts): out past its node, up to the lowest lane
 * that clears what it runs over, and back, no two on one line. The watch's Clear alarm stands under
 * its Raise alarm, and the three ways back out of the two rise side by side through the gap after the
 * Raise alarm — its own already up first, then the Clear alarm's two, past the name of raised — so
 * that gap is 32 wider than the rest. At 96 there was no room for them, and the Clear alarm's went on
 * under the Sound and came up beside the Notify, as if they led there. The simulator's inner loop
 * stands a row lower than the outer one, so its return runs under the outer loop's, over its own body.
 *
 * The watch's main line is nine nodes long, too long to read fitted to the canvas, so the canvas
 * opens it at a size it can be read at, from its Start or on the node picked (see FlowCanvas).
 */
export function exampleFlows(): FlowDto[] {
  const simulator: FlowDto = {
    id: newId('f'),
    name: 'Boiler simulator',
    enabled: false,
    variables: [{ name: 'sensors', value: '["k1","k2","k3"]' }],
    nodes: [
      { id: 'start', type: 'start', x: 40, y: 120, config: {} },
      { id: 'loop', type: 'for', x: 324, y: 120, config: { times: '', forever: true } },
      { id: 'each', type: 'forEach', x: 608, y: 240, config: { array: 'var.sensors' } },
      {
        id: 'send',
        type: 'publish',
        x: 892,
        y: 240,
        config: { topic: 'plant/{{payload}}/temp', payload: '{"temp": {{random(80,95)}}}', qos: 0, retain: false },
      },
      // Out past the Publish, so its way back rises clear of it and of the For each's own.
      { id: 'tick', type: 'wait', x: 916, y: 416, config: { seconds: '2' } },
      { id: 'end', type: 'end', x: 480, y: 416, config: {} },
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
      { id: 'start', type: 'start', x: 40, y: 120, config: {} },
      { id: 'loop', type: 'for', x: 324, y: 120, config: { times: '', forever: true } },
      { id: 'read', type: 'mqttIn', x: 608, y: 120, config: { filter: 'plant/+/temp', replay: false } },
      { id: 'say', type: 'debug', x: 892, y: 120, config: {} },
      { id: 'test', type: 'if', x: 1176, y: 92, config: { field: '$.temp', test: 'gt', value: '{{var.limit}}', value2: '' } },
      {
        id: 'hot',
        type: 'alarmRaise',
        x: 1524,
        y: 120,
        config: { name: 'Boiler too hot', level: 'warn', reason: '{{topic[1]}} is at {{$.temp}} °C', value: '$.temp' },
      },
      { id: 'beep', type: 'sound', x: 1840, y: 120, config: { level: 'warn' } },
      { id: 'tell', type: 'notify', x: 2124, y: 120, config: { text: '{{topic[1]}} is at {{$.temp}} °C', level: 'warn' } },
      {
        id: 'fan',
        type: 'publish',
        x: 2408,
        y: 120,
        config: { topic: 'plant/{{topic[1]}}/cmd', payload: '{"fan":"on"}', qos: 1, retain: false },
      },
      // Under its Raise alarm: both of its ways back rise with the Raise alarm's, after it.
      { id: 'cool', type: 'alarmClear', x: 1524, y: 296, config: { alarm: 'hot' } },
      { id: 'end', type: 'end', x: 480, y: 296, config: {} },
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
