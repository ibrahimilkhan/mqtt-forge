import type { FlowDto } from '../../types/api';
import { newId } from './flowDocument';

/**
 * The two flows "Start from an example" makes: a simulator that publishes three boilers'
 * temperatures, and a watch that raises an alarm and turns a fan on when one runs hot. Together
 * they need no device at all — deploy both and the rail's alarm badge lights within seconds —
 * and between them they use a trigger of each kind but Inject, all three loops but Repeat, and
 * every action.
 *
 * Real-world on purpose: a plant, boilers, a fan command. `foo/bar` teaches nothing.
 */
export function exampleFlows(): FlowDto[] {
  const simulator: FlowDto = {
    id: newId('f'),
    name: 'Boiler simulator',
    enabled: true,
    nodes: [
      { id: 'tick', type: 'every', x: 40, y: 100, config: { seconds: 2, topic: '', payload: '["k1","k2","k3"]' } },
      { id: 'each', type: 'forEach', x: 300, y: 100, config: { field: '' } },
      {
        id: 'send',
        type: 'publish',
        x: 560,
        y: 100,
        config: { topic: 'plant/{{payload}}/temp', payload: '{"temp": {{random(80,95)}}}', qos: 0, retain: false },
      },
    ],
    edges: [
      { id: 'e1', from: 'tick', fromPort: 'out', to: 'each', toPort: 'in' },
      { id: 'e2', from: 'each', fromPort: 'out', to: 'send', toPort: 'in' },
    ],
  };

  const watch: FlowDto = {
    id: newId('f'),
    name: 'Boiler watch',
    enabled: true,
    nodes: [
      { id: 'in', type: 'mqttIn', x: 40, y: 140, config: { filter: 'plant/+/temp', replay: false } },
      { id: 'test', type: 'if', x: 300, y: 140, config: { field: '$.temp', test: 'gt', value: '90', value2: '' } },
      {
        id: 'hot',
        type: 'alarm',
        x: 580,
        y: 40,
        config: {
          name: 'Boiler too hot',
          severity: 'warn',
          reason: '{{topic[1]}} is at {{$.temp}} °C',
          value: '$.temp',
          sound: false,
          webhook: '',
          publish: false,
          publishTopic: '',
          qos: 1,
          retain: false,
        },
      },
      {
        id: 'fan',
        type: 'publish',
        x: 580,
        y: 220,
        config: { topic: 'plant/{{topic[1]}}/cmd', payload: '{"fan":"on"}', qos: 1, retain: false },
      },
      { id: 'say', type: 'debug', x: 300, y: 320, config: {} },
    ],
    edges: [
      { id: 'e1', from: 'in', fromPort: 'out', to: 'test', toPort: 'in' },
      { id: 'e2', from: 'test', fromPort: 'yes', to: 'hot', toPort: 'raise' },
      { id: 'e3', from: 'test', fromPort: 'yes', to: 'fan', toPort: 'in' },
      { id: 'e4', from: 'test', fromPort: 'no', to: 'hot', toPort: 'clear' },
      { id: 'e5', from: 'in', fromPort: 'out', to: 'say', toPort: 'in' },
    ],
  };

  return [simulator, watch];
}
