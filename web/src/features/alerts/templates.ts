import { draftOf, type ConditionType, type DraftCondition, type DraftRule } from './ruleDraft';

/**
 * One worked example for each kind of condition the engine knows.
 *
 * A template is a whole rule, not a condition: a reader who has never written one learns more
 * from 'this topic, this test, this loud' than from a box labelled Threshold. Every field of it
 * stays editable — pressing Use opens the ordinary editor on a copy.
 *
 * `says` is the kind in one line and `story` is the same thing as something that happens in a
 * house, which is what the mark on the card opens. Two sentences at most: the card does not grow
 * to hold it.
 */
export type RuleTemplate = {
  type: ConditionType;
  says: string;
  story: string;
  /** A fresh draft every time, so two rules started from one template share nothing. */
  draft: () => DraftRule;
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
  ...rest,
});

/** In the order the editor's own list offers the kinds. */
export const TEMPLATES: readonly RuleTemplate[] = [
  {
    type: 'threshold',
    says: 'Value crosses a limit.',
    story:
      'Water pipes run through the garage. If it drops below 13 °C overnight, you are warned before they freeze.',
    draft: made('Garage low temperature', 'sensors/garage/temp', {
      type: 'threshold',
      op: 'lt',
      value: '13',
    }),
  },
  {
    type: 'band',
    says: 'Value leaves or enters a range.',
    story:
      'A boiler is safe between 1 and 2.5 bar. A leak lowers the pressure, a stuck valve raises it. Either one alerts.',
    draft: made('Boiler pressure range', 'sensors/boiler/pressure', {
      type: 'band',
      low: '1',
      high: '2.5',
      inside: false,
    }),
  },
  {
    type: 'pattern',
    says: 'Text matches a regular expression.',
    story:
      'A device publishes log lines. A line such as ERR-502 fires the alert; ordinary lines are ignored.',
    draft: made('Device error log', 'devices/+/log', {
      type: 'pattern',
      regex: '^ERR-[0-9]+',
      negate: false,
    }),
  },
  {
    type: 'oneOf',
    says: 'Value is one of a fixed set.',
    story:
      'A lamp reports its state. “on” and “off” are normal; “fault” or “offline” raises an alert.',
    draft: made(
      'Lamp fault state',
      'devices/lamp/+/state',
      { type: 'oneOf', values: 'fault\noffline', negate: false },
      { severity: 'critical' },
    ),
  },
  {
    type: 'silence',
    says: 'No message for a set time.',
    story:
      'The loft sensor reports every minute. Its battery dies and nothing arrives. After 15 minutes you are told.',
    draft: made(
      'Loft sensor silent',
      'sensors/loft/temp',
      { type: 'silence', after: '900' },
      { severity: 'info' },
    ),
  },
  {
    type: 'outlier',
    says: 'A reading far from recent values.',
    story:
      'The energy meter climbs steadily. One reading jumps far above the rest: a glitch or a short circuit. That reading fires.',
    draft: made('Energy meter outlier', 'home/energy/meter', {
      type: 'outlier',
      method: 'sigma',
      k: '3',
      window: '',
    }),
  },
  {
    type: 'distributionShift',
    says: 'Recent values settle at a different level.',
    story:
      'Kitchen humidity sat around 55% last week and now sits around 65%. No single reading is alarming, but the level has moved.',
    draft: made('Kitchen humidity drift', 'sensors/kitchen/humidity', {
      type: 'distributionShift',
      window: '200',
    }),
  },
  {
    type: 'shapeChange',
    says: 'A value changes character.',
    story:
      'A fan’s speed normally varies smoothly. After a controller fault it only jumps between stopped and full: a quantity has become a switch.',
    draft: made('Fan speed shape', 'devices/fan/speed', { type: 'shapeChange', window: '200' }),
  },
  {
    type: 'pulse',
    says: 'Counts or times the pulses in a signal.',
    story:
      'The front door normally opens once or twice an hour. More than five openings in the sample is unusual.',
    draft: made('Front door activity', 'alerts/door/front', {
      type: 'pulse',
      metric: 'count',
      op: 'gt',
      value: '5',
      window: '',
    }),
  },
  {
    type: 'all',
    says: 'Every listed condition is true.',
    story:
      'A cold night alone is normal. Alert only when the garage is cold and the reading is also abnormal.',
    draft: made('Garage cold and abnormal', 'sensors/garage/temp', {
      type: 'all',
      of: [
        { type: 'threshold', op: 'lt', value: '13' },
        { type: 'outlier', method: 'sigma', k: '3', window: '' },
      ],
    }),
  },
  {
    type: 'any',
    says: 'At least one listed condition is true.',
    story:
      'The garage is near freezing, or its sensor has stopped reporting. Either one is a problem.',
    draft: made('Garage cold or silent', 'sensors/garage/temp', {
      type: 'any',
      of: [
        { type: 'threshold', op: 'lt', value: '5' },
        { type: 'silence', after: '600' },
      ],
    }),
  },
];
