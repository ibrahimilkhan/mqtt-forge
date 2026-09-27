import { Field } from '../../components/Field';
import { QosSelect } from '../../components/QosSelect';
import { Segmented } from '../../components/Segmented';
import panel from '../../styles/panel.module.css';
import type { FlowNodeDto } from '../../types/api';
import { IF_TESTS, isNodeType, SEVERITIES, TEMPLATE_HELP } from './nodeTypes';
import styles from './Inspector.module.css';

type Facts = { allowWebhooks: boolean; alertTopicPrefix: string };

type Props = {
  flowId: string;
  node: FlowNodeDto;
  /** Merges into the node's settings in the draft. */
  set: (patch: Record<string, unknown>) => void;
  facts: Facts;
};

/**
 * One form per node type. Every box writes straight into the draft; nothing here is checked —
 * the server's compiler is the one judge of a setting, and it says what is wrong at deploy, on
 * the node it is about. A number box writes its text, which the compiler reads as a number.
 */
export function NodeSettings({ flowId, node, set, facts }: Props) {
  const config = node.config;
  const id = (name: string) => `${flowId}-${node.id}-${name}`;
  const text = (name: string) =>
    typeof config[name] === 'string' ? (config[name] as string) : typeof config[name] === 'number' ? String(config[name]) : '';
  const flag = (name: string) => config[name] === true;

  const box = (name: string, label: string, placeholder = '', mono = true) => (
    <Field label={label} htmlFor={id(name)}>
      <input
        id={id(name)}
        className={mono ? styles.mono : undefined}
        value={text(name)}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(event) => set({ [name]: event.target.value })}
      />
    </Field>
  );

  const area = (name: string, label: string, placeholder = '') => (
    <Field label={label} htmlFor={id(name)}>
      <textarea
        id={id(name)}
        className={styles.mono}
        rows={3}
        value={text(name)}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(event) => set({ [name]: event.target.value })}
      />
    </Field>
  );

  const number = (name: string, label: string, min: number, step: number) => (
    <Field label={label} htmlFor={id(name)} narrow>
      <input
        id={id(name)}
        type="number"
        min={min}
        step={step}
        value={text(name)}
        onChange={(event) => set({ [name]: event.target.value })}
      />
    </Field>
  );

  const check = (name: string, label: string) => (
    <label className={styles.check}>
      <input type="checkbox" checked={flag(name)} onChange={(event) => set({ [name]: event.target.checked })} />
      {label}
    </label>
  );

  const templates = <p className={panel.hint}>Fills in: {TEMPLATE_HELP}</p>;

  // A node a newer build wrote can be of a type this one has no form for. It is taken as null, so
  // the switch covers every node there is — see its default.
  const known = isNodeType(node.type) ? node.type : null;

  switch (known) {
    case 'mqttIn':
      return (
        <>
          {box('filter', 'Filter', 'plant/+/temp')}
          {check('replay', 'Also run on retained values sent at subscribe')}
        </>
      );

    case 'every':
      return (
        <>
          {number('seconds', 'Every (seconds)', 0.1, 0.1)}
          {box('topic', 'Topic', 'optional')}
          {area('payload', 'Payload', '["k1","k2","k3"]')}
        </>
      );

    case 'inject':
      return (
        <>
          {box('topic', 'Topic', 'plant/k1/cmd')}
          {area('payload', 'Payload', '{"fan":"on"}')}
          <p className={panel.hint}>Press ▶ on the node to send this once the flow is deployed.</p>
        </>
      );

    case 'if': {
      const test = text('test');
      return (
        <>
          {box('field', 'Field', '$.temp — empty for the whole payload')}
          <Field label="Test" htmlFor={id('test')}>
            <select id={id('test')} value={test} onChange={(event) => set({ test: event.target.value })}>
              {IF_TESTS.map((one) => (
                <option key={one.value} value={one.value}>
                  {one.label}
                </option>
              ))}
            </select>
          </Field>
          {test !== 'exists' && box('value', 'Value', test === 'matches' ? '^warn' : test === 'oneOf' ? 'on, off' : '90')}
          {test === 'between' && box('value2', 'And', '100')}
          <p className={panel.hint}>A message without the field goes down neither branch.</p>
        </>
      );
    }

    case 'forEach':
      return box('field', 'Array', '$.sensors — empty if the payload is the array');

    case 'repeat':
      return (
        <>
          <div className={panel.row}>
            {number('count', 'Times', 1, 1)}
            {number('seconds', 'Apart (seconds)', 0, 0.1)}
          </div>
          <p className={panel.hint}>0 seconds sends every copy at once.</p>
        </>
      );

    case 'alarm':
      return (
        <>
          {box('name', 'Name', 'Boiler too hot', false)}
          <Segmented
            label="Level"
            name={id('severity')}
            options={SEVERITIES}
            value={(text('severity') || 'warn') as (typeof SEVERITIES)[number]['value']}
            onChange={(severity) => set({ severity })}
          />
          {box('reason', 'Reason', '{{topic[1]}} is at {{$.temp}} °C')}
          {templates}
          {box('value', 'Number', '$.temp — empty for the whole payload')}
          {check('sound', 'Play a sound')}
          {box('webhook', 'Webhook', 'https://hooks.example.com/boiler')}
          {!facts.allowWebhooks && (
            <p className={panel.note}>Webhooks are turned off on this host, so none will be sent.</p>
          )}
          {check('publish', 'Publish it to the broker')}
          {flag('publish') && (
            <>
              {box('publishTopic', 'Topic', `${facts.alertTopicPrefix}flow-…/{topic}`)}
              <QosSelect name={id('qos')} value={Number(text('qos') || 1)} onChange={(qos) => set({ qos })} />
              {check('retain', 'Retain')}
            </>
          )}
        </>
      );

    case 'publish':
      return (
        <>
          {box('topic', 'Topic', 'plant/{{topic[1]}}/cmd')}
          {area('payload', 'Payload', '{"fan":"on"}')}
          {templates}
          <QosSelect name={id('qos')} value={Number(text('qos') || 0)} onChange={(qos) => set({ qos })} />
          {check('retain', 'Retain')}
        </>
      );

    case 'debug':
      return <p className={panel.note}>Prints every message it is given in Debug, under the canvas.</p>;

    default:
      // Every type this build knows has its case above, and this line stops the build when one
      // does not: only null — a type it does not know — may reach it. Such a node's settings are
      // kept as they came, untouched, and Remove node under this still takes it out.
      known satisfies null;
      return (
        <p className={panel.note}>
          This build does not know a node called “{node.type}”. Its settings are kept as they are, and the flow will
          not deploy until it is removed.
        </p>
      );
  }
}
