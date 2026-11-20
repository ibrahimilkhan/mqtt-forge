import { draftOf, type ConditionType, type DraftCondition, type DraftRule } from './ruleDraft';

/**
 * A worked example of every setting of every kind of condition the engine knows.
 *
 * Grouped by kind, because one example a kind taught what a kind is and not what it can do: a
 * reader who saw `threshold < 13` never learnt that the same condition reads a JSON field, waits
 * out a For, or asks ≠. Each example is a whole rule, not a condition — 'this topic, this test,
 * this loud' teaches more than a box labelled Threshold — and every field of it stays editable:
 * Use opens the ordinary editor on a copy.
 *
 * `says` is the kind in one line, under its heading. `story` is the example as something that
 * happens in a building, behind the mark on its card. Two sentences at most: the card does not
 * grow to hold it.
 */
export type RuleExample = {
  /** The scenario's name on its card. Unique across the library, since it names the card. */
  title: string;
  story: string;
  /** A fresh draft every time, so two rules started from one example share nothing. */
  draft: () => DraftRule;
};

export type TemplateGroup = {
  type: ConditionType;
  says: string;
  examples: readonly RuleExample[];
};

const made = (
  name: string,
  filter: string,
  condition: DraftCondition,
  rest: Partial<DraftRule> = {},
): (() => DraftRule) => () => ({
  ...draftOf(undefined, undefined),
  name,
  filter,
  condition: structuredClone(condition),
  ...structuredClone(rest),
});

/** In the order the editor's own list offers the kinds. */
export const TEMPLATE_GROUPS: readonly TemplateGroup[] = [
  {
    type: 'threshold',
    says: 'Value crosses a limit.',
    examples: [
      {
        title: 'Upper limit',
        story: 'The server rack should stay below 35 °C. A failed fan pushes it over, and you hear about it.',
        draft: made('Rack too hot', 'sensors/rack/temp', { type: 'threshold', op: 'gt', value: '35' }),
      },
      {
        title: 'Lower limit',
        story: 'Water pipes run through the garage. If it drops below 13 °C overnight, you are warned before they freeze.',
        draft: made('Garage low temperature', 'sensors/garage/temp', { type: 'threshold', op: 'lt', value: '13' }),
      },
      {
        title: 'Equals',
        story: 'The pump reports 1 while it runs and 0 when it stops. A 0 is worth knowing about.',
        draft: made('Pump stopped', 'devices/pump/state', { type: 'threshold', op: 'eq', value: '0' }),
      },
      {
        title: 'Not equal',
        story: 'The heating should always be in mode 1, automatic. Anyone switching it to anything else is noticed.',
        draft: made('Heating not on automatic', 'devices/hvac/mode', { type: 'threshold', op: 'neq', value: '1' }),
      },
      {
        title: 'Battery from a JSON field',
        story: 'Every device sends {"battery": 87, ...}. The rule reads only the battery field and warns below 20%.',
        draft: made(
          'Device battery low',
          'devices/+/status',
          { type: 'threshold', op: 'lt', value: '20' },
          { field: 'battery' },
        ),
      },
      {
        title: 'Only if it lasts',
        story: 'A CPU spikes to 100% for a moment all the time. Above 90% for two whole minutes is a real problem.',
        draft: made(
          'CPU busy for two minutes',
          'servers/+/cpu',
          { type: 'threshold', op: 'gt', value: '90' },
          { for: '120' },
        ),
      },
    ],
  },
  {
    type: 'band',
    says: 'Value leaves or enters a range.',
    examples: [
      {
        title: 'Leaves its range',
        story: 'A 4-20 mA line reads below 4 when the wire breaks and above 20 when it shorts. Either alerts.',
        draft: made(
          '4-20 mA line fault',
          'sensors/line/current',
          { type: 'band', low: '4', high: '20', inside: false },
          { severity: 'critical' },
        ),
      },
      {
        title: 'Enters a range',
        story: 'Mould grows when the cellar stays between 70% and 100% humidity. Entering that zone alerts.',
        draft: made('Cellar in the mould zone', 'sensors/cellar/humidity', {
          type: 'band',
          low: '70',
          high: '100',
          inside: true,
        }),
      },
      {
        title: 'Clears with a margin',
        story: 'The boiler is safe between 1 and 2.5 bar. The alert clears only once it is back between 1.2 and 2.3, so a reading hovering at the edge does not flap.',
        draft: made(
          'Boiler pressure, with a margin',
          'sensors/boiler/pressure',
          { type: 'band', low: '1', high: '2.5', inside: false },
          { clear: { type: 'band', low: '1.2', high: '2.3', inside: true } },
        ),
      },
    ],
  },
  {
    type: 'pattern',
    says: 'Text matches what you describe.',
    examples: [
      {
        title: 'Contains',
        story: 'A device writes log lines. Any line with ERROR in it, anywhere, raises an alert.',
        draft: made('Error in a device log', 'devices/+/log', { type: 'pattern', regex: 'ERROR', negate: false }),
      },
      {
        title: 'Starts with',
        story: 'Error lines begin with a code such as ERR-502. Lines that merely mention one later are ignored.',
        draft: made('Device error code', 'devices/+/log', { type: 'pattern', regex: '^ERR-', negate: false }),
      },
      {
        title: 'Ends with',
        story: 'The gateway reports events like "upload timeout". Anything ending in timeout alerts.',
        draft: made('Gateway timeout', 'gateway/+/event', { type: 'pattern', regex: 'timeout$', negate: false }),
      },
      {
        title: 'Is exactly',
        story: 'A device says OFFLINE, and only that, when it drops off. "OFFLINE soon" is not the same thing.',
        draft: made('Device offline', 'devices/+/status', { type: 'pattern', regex: '^OFFLINE$', negate: false }),
      },
      {
        title: 'Does not match',
        story: 'Every device should be on firmware 2.x. One that reports anything not starting with 2. is out of date.',
        draft: made(
          'Old firmware',
          'devices/+/firmware',
          { type: 'pattern', regex: '^2\\.', negate: true },
          { severity: 'info' },
        ),
      },
      {
        title: 'Regular expression on a field',
        story: 'Events arrive as {"msg": "..."}. A message reporting a timeout or a refused connection alerts.',
        draft: made(
          'Connection trouble',
          'devices/+/event',
          { type: 'pattern', regex: 'timeout|refused', negate: false },
          { field: 'msg' },
        ),
      },
    ],
  },
  {
    type: 'oneOf',
    says: 'Value is one of a fixed set.',
    examples: [
      {
        title: 'Deny-list',
        story: 'A lamp reports its state. "on" and "off" are normal; "fault" or "offline" raises an alert.',
        draft: made(
          'Lamp fault state',
          'devices/lamp/+/state',
          { type: 'oneOf', values: 'fault\noffline', negate: false },
          { severity: 'critical' },
        ),
      },
      {
        title: 'Allow-list',
        story: 'A door is open or closed. Anything else — "jammed", an empty message, a typo — is unexpected.',
        draft: made('Door in an unknown state', 'devices/door/+/state', {
          type: 'oneOf',
          values: 'open\nclosed',
          negate: true,
        }),
      },
      {
        title: 'Status from a JSON field',
        story: 'Devices send {"status": "ok", ...}. The rule reads the status field alone and alerts on error or fault.',
        draft: made(
          'Device reports an error',
          'devices/+/status',
          { type: 'oneOf', values: 'error\nfault', negate: false },
          { field: 'status' },
        ),
      },
    ],
  },
  {
    type: 'silence',
    says: 'No message for a set time.',
    examples: [
      {
        title: 'Battery died',
        story: 'The loft sensor reports every minute. Its battery dies and nothing arrives. After 15 minutes you are told.',
        draft: made('Loft sensor silent', 'sensors/loft/temp', { type: 'silence', after: '900' }, { severity: 'info' }),
      },
      {
        title: 'Heartbeat',
        story: 'The PLC sends a heartbeat every 5 seconds. Thirty seconds without one means it has stopped.',
        draft: made(
          'PLC heartbeat lost',
          'plc/main/heartbeat',
          { type: 'silence', after: '30' },
          { severity: 'critical' },
        ),
      },
      {
        title: 'Every device on its own',
        story: 'One rule watches every device’s heartbeat. Each one that goes quiet for two minutes alerts by name.',
        draft: made('Device heartbeat lost', 'devices/+/heartbeat', { type: 'silence', after: '120' }),
      },
    ],
  },
  {
    type: 'outlier',
    says: 'A reading far from recent values.',
    examples: [
      {
        title: 'Sigma fence',
        story: 'The energy meter climbs steadily. One reading jumps far above the rest: a glitch or a short circuit.',
        draft: made('Energy meter outlier', 'home/energy/meter', {
          type: 'outlier',
          method: 'sigma',
          k: '3',
          window: '',
        }),
      },
      {
        title: 'Tukey fence',
        story: 'Water flow is mostly low with the odd long run, so it is lopsided. Tukey’s fence copes with that where sigma would cry wolf.',
        draft: made('Flow rate outlier', 'sensors/flow/rate', {
          type: 'outlier',
          method: 'tukey',
          k: '1.5',
          window: '',
        }),
      },
      {
        title: 'Short memory',
        story: 'Vibration changes with the load through the day. Judging each reading against only the last 50 follows that.',
        draft: made('Vibration spike', 'sensors/vibration/rms', {
          type: 'outlier',
          method: 'sigma',
          k: '3',
          window: '50',
        }),
      },
    ],
  },
  {
    type: 'distributionShift',
    says: 'Recent values settle at a different level.',
    examples: [
      {
        title: 'Level moved',
        story: 'Kitchen humidity sat around 55% last week and now sits around 65%. No single reading is alarming, but the level has moved.',
        draft: made('Kitchen humidity drift', 'sensors/kitchen/humidity', {
          type: 'distributionShift',
          window: '200',
        }),
      },
      {
        title: 'Slow drift',
        story: 'A level sensor creeps as it loses calibration. Over a thousand readings the creep shows where a short sample would not.',
        draft: made('Tank level calibration drift', 'sensors/tank/level', {
          type: 'distributionShift',
          window: '1000',
        }),
      },
    ],
  },
  {
    type: 'shapeChange',
    says: 'A value changes character.',
    examples: [
      {
        title: 'Quantity became a switch',
        story: 'A fan’s speed normally varies smoothly. After a controller fault it only jumps between stopped and full.',
        draft: made('Fan speed shape', 'devices/fan/speed', { type: 'shapeChange', window: '200' }),
      },
      {
        title: 'Sensor stuck',
        story: 'A door contact flips between open and closed all day. When it sends one value for ever, the sensor is stuck.',
        draft: made('Door contact stuck', 'sensors/door/contact', { type: 'shapeChange', window: '200' }),
      },
    ],
  },
  {
    type: 'pulse',
    says: 'Counts or times the pulses in a signal.',
    examples: [
      {
        title: 'Pulse count',
        story: 'The front door normally opens once or twice an hour. More than five openings in the sample is unusual.',
        draft: made('Front door activity', 'alerts/door/front', {
          type: 'pulse',
          metric: 'count',
          op: 'gt',
          value: '5',
          window: '',
        }),
      },
      {
        title: 'Pulse share',
        story: 'The pump is off most of the time. Running in more than 3 readings of every 10 means something is drawing water.',
        draft: made('Pump running too much', 'devices/pump/run', {
          type: 'pulse',
          metric: 'duty',
          op: 'gt',
          value: '0.3',
          window: '',
        }),
      },
      {
        title: 'Pulse interval',
        story: 'The beacon blinks every second. Blinks more than two seconds apart mean it is failing.',
        draft: made('Beacon blinking slowly', 'devices/beacon/led', {
          type: 'pulse',
          metric: 'period',
          op: 'gt',
          value: '2000',
          window: '',
        }),
      },
      {
        title: 'Pulse duration',
        story: 'The valve opens for a second or two at a time. Open for longer than five seconds, it is sticking.',
        draft: made('Valve sticking open', 'devices/valve/open', {
          type: 'pulse',
          metric: 'width',
          op: 'gt',
          value: '5000',
          window: '',
        }),
      },
    ],
  },
  {
    type: 'all',
    says: 'Every listed condition is true.',
    examples: [
      {
        title: 'Cold and abnormal',
        story: 'A cold night alone is normal. Alert only when the garage is cold and the reading is also abnormal.',
        draft: made('Garage cold and abnormal', 'sensors/garage/temp', {
          type: 'all',
          of: [
            { type: 'threshold', op: 'lt', value: '13' },
            { type: 'outlier', method: 'sigma', k: '3', window: '' },
          ],
        }),
      },
      {
        title: 'Out of range and chattering',
        story: 'A line that leaves its range once is a blip. Out of range and flicking in and out more than ten times is a loose wire.',
        draft: made('Loose wire on the line', 'sensors/line/current', {
          type: 'all',
          of: [
            { type: 'band', low: '4', high: '20', inside: false },
            { type: 'pulse', metric: 'count', op: 'gt', value: '10', window: '' },
          ],
        }),
      },
    ],
  },
  {
    type: 'any',
    says: 'At least one listed condition is true.',
    examples: [
      {
        title: 'Cold or silent',
        story: 'The garage is near freezing, or its sensor has stopped reporting. Either one is a problem.',
        draft: made('Garage cold or silent', 'sensors/garage/temp', {
          type: 'any',
          of: [
            { type: 'threshold', op: 'lt', value: '5' },
            { type: 'silence', after: '600' },
          ],
        }),
      },
      {
        title: 'Error text or fault state',
        story: 'A device may say ERROR in a sentence, or report the single word fault. Either is worth hearing about.',
        draft: made('Device in trouble', 'devices/+/status', {
          type: 'any',
          of: [
            { type: 'pattern', regex: 'ERROR', negate: false },
            { type: 'oneOf', values: 'fault', negate: false },
          ],
        }),
      },
    ],
  },
];
