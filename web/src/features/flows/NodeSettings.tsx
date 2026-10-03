import { Field } from '../../components/Field';
import { QosSelect } from '../../components/QosSelect';
import { Segmented } from '../../components/Segmented';
import panel from '../../styles/panel.module.css';
import type { FlowDto, FlowNodeDto, FlowsDto } from '../../types/api';
import { IF_TESTS, isNodeType, levelOf, SEVERITIES, specOf, textOf } from './nodeTypes';
import styles from './Inspector.module.css';

/** What the server says about this host that the forms need: whether webhooks may be sent. */
export type Facts = Pick<FlowsDto, 'allowWebhooks'>;

type Props = {
  /** The flow the node is in: a Set picks one of its variables, and a Clear alarm one of its Raise alarms. */
  flow: FlowDto;
  node: FlowNodeDto;
  /** Merges into the node's settings in the draft. */
  set: (patch: Record<string, unknown>) => void;
  facts: Facts;
};

/**
 * One form per node type. Every box writes straight into the draft; nothing here is checked — the
 * server's compiler is the one judge of a setting, and it says what is wrong on the node it is
 * about. Counts and seconds are text boxes, not number ones, so `{{var.n}}` can be typed into them
 * as well as a number; the compiler reads either.
 *
 * A box a choice hides or turns off — an If's value under exists, a For's times while it runs
 * forever — keeps what it held. The compiler does not read a setting the choice does not ask for,
 * so nothing is lost by keeping it, and a reader who changes their mind back finds it still there.
 */
export function NodeSettings({ flow, node, set, facts }: Props) {
  const config = node.config;
  const id = (name: string) => `${flow.id}-${node.id}-${name}`;
  const text = (name: string) => textOf(config[name]);
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

  const check = (name: string, label: string) => (
    <label className={styles.check}>
      <input type="checkbox" checked={flag(name)} onChange={(event) => set({ [name]: event.target.checked })} />
      {label}
    </label>
  );

  // A node a newer build wrote can be of a type this one has no form for. It is taken as null, so
  // the switch covers every node there is — see its default.
  const known = isNodeType(node.type) ? node.type : null;

  switch (known) {
    case 'start':
      return <p className={panel.note}>Every run begins here. It has no settings.</p>;

    case 'end':
      return <p className={panel.note}>A run that gets here is finished.</p>;

    case 'mqttIn':
      return (
        <>
          {box('filter', 'Filter', 'plant/+/temp')}
          {check('replay', 'Also read retained values sent at subscribe')}
        </>
      );

    case 'if': {
      const test = text('test');
      return (
        <>
          {box('field', 'Field', '$.temp or var.limit — empty for the whole payload')}
          <Field label="Test" htmlFor={id('test')}>
            <select id={id('test')} value={test} onChange={(event) => set({ test: event.target.value })}>
              {IF_TESTS.map((one) => (
                <option key={one.value} value={one.value}>
                  {one.label}
                </option>
              ))}
            </select>
          </Field>
          {test !== 'exists' && box('value', 'Value', test === 'matches' ? '^warn' : test === 'oneOf' ? 'on, off' : '90 or {{var.limit}}')}
          {test === 'between' && box('value2', 'And', '100')}
          <p className={panel.hint}>A message without the field goes no.</p>
        </>
      );
    }

    case 'for':
      return (
        <>
          <Field label="Times" htmlFor={id('times')} narrow>
            <input
              id={id('times')}
              value={text('times')}
              placeholder="3 or {{var.n}}"
              disabled={flag('forever')}
              onChange={(event) => set({ times: event.target.value })}
            />
          </Field>
          {check('forever', 'Forever')}
          <p className={panel.hint}>Wire body to the first step, and the last step back to next.</p>
        </>
      );

    case 'forEach':
      return box('array', 'Array', '$.sensors or var.sensors — empty if the payload is the array');

    case 'wait':
      return box('seconds', 'Seconds', '1 or {{var.delay}}');

    case 'set':
      return (
        <>
          <Field label="Variable" htmlFor={id('variable')}>
            <select id={id('variable')} value={text('variable')} onChange={(event) => set({ variable: event.target.value })}>
              <option value="">Pick a variable</option>
              {flow.variables.map((variable) => (
                <option key={variable.name} value={variable.name}>
                  {variable.name}
                </option>
              ))}
            </select>
          </Field>
          {flow.variables.length === 0 && <p className={panel.hint}>Add a variable in the flow’s settings first.</p>}
          {box('value', 'Value', '90 or {{$.limit}}')}
        </>
      );

    case 'publish':
      return (
        <>
          {box('topic', 'Topic', 'plant/{{topic[1]}}/cmd')}
          {area('payload', 'Payload', '{"fan":"on"}')}
          <QosSelect name={id('qos')} value={Number(text('qos') || 0)} onChange={(qos) => set({ qos })} />
          {check('retain', 'Retain')}
        </>
      );

    case 'debug':
      return <p className={panel.note}>Prints every message it is given in Debug, under the canvas.</p>;

    case 'alarmRaise':
      return (
        <>
          {box('name', 'Name', 'Boiler too hot', false)}
          <Segmented label="Level" name={id('level')} options={SEVERITIES} value={levelOf(config.level)} onChange={(level) => set({ level })} />
          {box('reason', 'Reason', '{{topic[1]}} is at {{$.temp}} °C')}
          {box('value', 'Number', '$.temp or var.limit — empty for the whole payload')}
        </>
      );

    case 'alarmClear':
      return (
        <Field label="Alarm" htmlFor={id('alarm')}>
          <select id={id('alarm')} value={text('alarm')} onChange={(event) => set({ alarm: event.target.value })}>
            <option value="">Pick an alarm</option>
            {flow.nodes
              .filter((one) => one.type === 'alarmRaise')
              .map((one) => (
                <option key={one.id} value={one.id}>
                  {textOf(one.config.name) || 'Alarm'}
                </option>
              ))}
          </select>
        </Field>
      );

    case 'sound':
      return <Segmented label="Level" name={id('level')} options={SEVERITIES} value={levelOf(config.level)} onChange={(level) => set({ level })} />;

    case 'notify':
      return (
        <>
          {area('text', 'Text', '{{topic[1]}} is at {{$.temp}} °C')}
          <Segmented label="Level" name={id('level')} options={SEVERITIES} value={levelOf(config.level)} onChange={(level) => set({ level })} />
        </>
      );

    case 'webhook':
      return (
        <>
          {box('url', 'Address', 'https://hooks.example.com/boiler')}
          {area('body', 'Body', '{{payload}}')}
          {!facts.allowWebhooks && <p className={panel.note}>Webhooks are turned off on this host, so nothing will be sent.</p>}
        </>
      );

    default:
      // Every type this build knows has its case above, and this line stops the build when one
      // does not: only null — a type it does not know — may reach it. Such a node's settings are
      // kept as they came, untouched, and Remove node under this still takes it out.
      known satisfies null;
      return <p className={panel.note}>{specOf(node.type).help}</p>;
  }
}
