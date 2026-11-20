import { Field } from '../../components/Field';
import { Example } from '../../components/InfoTip';
import panel from '../../styles/panel.module.css';
import type { OutlierMethod, PulseMetric, ThresholdOp } from '../../types/api';
import { PatternFields } from './PatternFields';
import { SIGN } from './ruleSummary';
import type { PatternSource } from './PatternTry';
import {
  blankCondition,
  conditionText,
  CONDITION_LABELS,
  CONDITION_SUMMARIES,
  defaultK,
  SIMPLE_TYPES,
  type ConditionType,
  type DraftCondition,
} from './ruleDraft';

/**
 * What the chosen condition does, under the select that chose it.
 *
 * The other half of shortening the picker to a word. A reader who knows what a band is reads
 * 'Range' and moves on; a reader who does not gets the sentence, once, where they are choosing —
 * rather than eleven of them stacked in a dropdown.
 *
 * Nothing for `opaque`: a condition this form cannot draw explains itself at length where it is
 * drawn, and a summary above that would be the console describing something it has just admitted
 * it cannot read.
 */
export function ConditionSummary({ type }: { type: ConditionType | 'opaque' }) {
  if (type === 'opaque') return null;

  return <p className={panel.pickNote}>{CONDITION_SUMMARIES[type]}</p>;
}

/**
 * The six operators, as the select offers them: the same signs the rules table writes, so the
 * form and the row it turns into cannot draw one comparison two ways.
 */
const OPS = (Object.keys(SIGN) as ThresholdOp[]).map((value) => ({ value, label: SIGN[value] }));

/**
 * The four numbers a pulse rule can compare, under the names a signal's are usually given.
 *
 * They were sentences once — 'share of readings past the line' — and a sentence in a list has to
 * be worked out before it can be chosen. The name is now the term with its unit, and the sentence
 * stands under the list for whichever one is picked.
 */
const METRICS: ReadonlyArray<{ value: PulseMetric; label: string; says: string }> = [
  { value: 'count', label: 'Pulse count', says: 'Number of separate pulses in the sample.' },
  {
    value: 'duty',
    // Not 'duty cycle': that is a share of time, and of the ON state, everywhere else the term
    // is used. This is a share of readings, and of whichever state is the rarer one — the engine
    // calls the minority side the pulse, so the number never passes one half. The name and the
    // line under it say both, because a rule written as 'on more than 0.8' can never fire.
    label: 'Pulse share (0–0.5)',
    says:
      'Fraction of the readings that are in the less common state. 0.25 means 1 reading in 4. ' +
      'Never above 0.5, and it counts readings, not seconds.',
  },
  {
    value: 'period',
    label: 'Pulse interval (ms)',
    says: 'Typical time from the start of one pulse to the start of the next. 60000 is one minute.',
  },
  {
    value: 'width',
    label: 'Pulse duration (ms)',
    says: 'Typical time a single pulse lasts. 5000 is five seconds.',
  },
];

/** What a pulse is here, for whoever presses the mark beside Metric. */
function PulseHelp() {
  return (
    <>
      <p>
        The engine decides what a pulse is; it is not typed in. It draws a line between the level
        the signal usually sits at and the level it jumps to, and whichever side the readings are
        on <b>less often</b> is the pulse. A door that is shut all day and open twice has two
        pulses. A pump that runs all day and stops twice also has two: the stops.
      </p>
      <p>
        When the two sides are exactly even, as in 0 1 0 1, the higher value is the pulse.
      </p>
      <Example
        rows={[
          ['Pulse count > 5', 'a door opened more than 5 times in the sample'],
          ['Pulse share > 0.3', 'a door is open in more than 3 of every 10 readings'],
          ['Pulse interval < 120000', 'a compressor starts more often than every 2 minutes'],
          ['Pulse duration > 30000', 'a valve stays open longer than 30 seconds'],
        ]}
      />
      <p>
        Because the pulse is always the rarer state, pulse share cannot tell &ldquo;on 80% of the
        readings&rdquo; from &ldquo;on 20%&rdquo;: both read 0.2. Interval needs two pulses and
        duration needs one that has ended; until then the rule does not fire.
      </p>
    </>
  );
}

type Props = {
  condition: DraftCondition;
  onChange: (condition: DraftCondition) => void;
  /** The window's own id maker, so two editors open at once do not share a field. */
  id: (name: string) => string;
  /** The rule's topic filter and field, which a pattern is tried against. Absent tries nothing. */
  source?: PatternSource;
};

const NOWHERE: PatternSource = { filter: '', field: '' };

/**
 * The parameters of one condition, and only of that one.
 *
 * Eleven forms rather than one form with every box on it and most of them greyed out: a reader
 * choosing 'nothing has arrived' is choosing a rule with one number in it, and eight disabled
 * fields underneath would be eight questions they have to read before deciding they are not being
 * asked them.
 *
 * Controlled all the way down for the condition itself — every keystroke goes out through
 * `onChange` and comes back as a new `condition` — which is what lets the editor keep one draft in
 * one place and write it through to the map on every change. `PatternFields` and `PatternTry`,
 * drawn for the pattern case, are the exception: the chosen mode and the any-word box text live in
 * `PatternFields`, and the tried messages and typed text live in `PatternTry`, because none of that
 * is part of the condition being saved.
 */
export function ConditionFields({ condition, onChange, id, source = NOWHERE }: Props) {
  switch (condition.type) {
    case 'threshold':
      return (
        <div className={panel.row}>
          <Field label="Operator" htmlFor={id('op')} narrow>
            <select
              id={id('op')}
              value={condition.op}
              onChange={(event) => onChange({ ...condition, op: event.target.value as ThresholdOp })}
            >
              {OPS.map((op) => (
                <option key={op.value} value={op.value}>
                  {op.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Value" htmlFor={id('value')}>
            <input
              id={id('value')}
              value={condition.value}
              inputMode="decimal"
              onChange={(event) => onChange({ ...condition, value: event.target.value })}
            />
          </Field>
        </div>
      );

    case 'band':
      return (
        <>
          <div className={panel.row}>
            <Field label="Low" htmlFor={id('low')}>
              <input
                id={id('low')}
                value={condition.low}
                inputMode="decimal"
                onChange={(event) => onChange({ ...condition, low: event.target.value })}
              />
            </Field>
            <Field label="High" htmlFor={id('high')}>
              <input
                id={id('high')}
                value={condition.high}
                inputMode="decimal"
                onChange={(event) => onChange({ ...condition, high: event.target.value })}
              />
            </Field>
          </div>
          <div className={panel.checks}>
            <label>
              <input
                type="checkbox"
                checked={condition.inside}
                onChange={(event) => onChange({ ...condition, inside: event.target.checked })}
              />
              Inside the range
            </label>
          </div>
          {/* What the tick changes, and nothing else: the summary over the fields has already
              said which way round a range fires. */}
          <p className={panel.note}>
            {condition.inside
              ? 'Both edges count as inside.'
              : 'The 4-20mA question — a reading that has left the pair.'}
          </p>
        </>
      );

    case 'pattern':
      return <PatternFields condition={condition} onChange={onChange} id={id} source={source} />;

    case 'oneOf':
      return (
        <>
          <Field label="One value to a line" htmlFor={id('values')}>
            <textarea
              id={id('values')}
              rows={4}
              value={condition.values}
              spellCheck={false}
              onChange={(event) => onChange({ ...condition, values: event.target.value })}
            />
          </Field>
          <div className={panel.checks}>
            <label>
              <input
                type="checkbox"
                checked={condition.negate}
                onChange={(event) => onChange({ ...condition, negate: event.target.checked })}
              />
              Fire when it is NOT one of these
            </label>
          </div>
        </>
      );

    case 'silence':
      return (
        <>
          <Field label="Seconds of silence" htmlFor={id('after')} narrow>
            <input
              id={id('after')}
              value={condition.after}
              inputMode="numeric"
              onChange={(event) => onChange({ ...condition, after: event.target.value })}
            />
          </Field>
          <p className={panel.note}>
            A silence can only be noticed on a topic that has spoken at least once: a topic that
            has never arrived is not a topic this console knows the name of.
          </p>
        </>
      );

    case 'outlier':
      return (
        <>
          <div className={panel.row}>
            <Field label="Method" htmlFor={id('method')} narrow>
              <select
                id={id('method')}
                value={condition.method}
                onChange={(event) => {
                  const method = event.target.value as OutlierMethod;

                  // The k goes back to the method's own default rather than being carried across.
                  // Tukey 3 is about 4.7σ and sigma 3 is 3σ: a number that travelled quietly
                  // between the two would change how tight the rule is by a factor of ten, and the
                  // reader would have watched it not change on screen.
                  onChange({ ...condition, method, k: defaultK(method) });
                }}
              >
                <option value="tukey">tukey</option>
                <option value="sigma">sigma</option>
              </select>
            </Field>
            <Field label="k" htmlFor={id('k')} narrow>
              <input
                id={id('k')}
                value={condition.k}
                inputMode="decimal"
                onChange={(event) => onChange({ ...condition, k: event.target.value })}
              />
            </Field>
            <WindowField
              window={condition.window}
              id={id}
              onChange={(window) => onChange({ ...condition, window })}
            />
          </div>
          <p className={panel.note}>
            {condition.method === 'tukey'
              ? 'k × IQR. 1.5 is the textbook fence; 0.5 to 5.'
              : 'k × σ. 3 is the control-chart default; 1 to 10.'}
          </p>
        </>
      );

    case 'distributionShift':
      return (
        <>
          <div className={panel.row}>
            <WindowField
              window={condition.window}
              id={id}
              onChange={(window) => onChange({ ...condition, window })}
            />
          </div>
          <p className={panel.note}>
            It fires once, at the moment it happens — so there is nothing here for &ldquo;For&rdquo;
            to wait out, and it cannot be given with one.
          </p>
        </>
      );

    case 'shapeChange':
      return (
        <>
          <div className={panel.row}>
            <WindowField
              window={condition.window}
              id={id}
              onChange={(window) => onChange({ ...condition, window })}
            />
          </div>
          <p className={panel.note}>
            It fires once, and it is the plant saying that whatever was written about this topic
            now describes something else.
          </p>
        </>
      );

    case 'pulse':
      return (
        <>
          <Field label="Metric" htmlFor={id('metric')} help={<PulseHelp />}>
            <select
              id={id('metric')}
              value={condition.metric}
              onChange={(event) =>
                onChange({ ...condition, metric: event.target.value as PulseMetric })
              }
            >
              {METRICS.map((metric) => (
                <option key={metric.value} value={metric.value}>
                  {metric.label}
                </option>
              ))}
            </select>
          </Field>
          <p className={panel.pickNote} data-testid="metric-says">
            {METRICS.find((metric) => metric.value === condition.metric)?.says}
          </p>
          <div className={panel.row}>
            <Field label="Operator" htmlFor={id('op')} narrow>
              <select
                id={id('op')}
                value={condition.op}
                onChange={(event) =>
                  onChange({ ...condition, op: event.target.value as ThresholdOp })
                }
              >
                {OPS.map((op) => (
                  <option key={op.value} value={op.value}>
                    {op.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Value" htmlFor={id('value')}>
              <input
                id={id('value')}
                value={condition.value}
                inputMode="decimal"
                onChange={(event) => onChange({ ...condition, value: event.target.value })}
              />
            </Field>
            <WindowField
              window={condition.window}
              id={id}
              onChange={(window) => onChange({ ...condition, window })}
            />
          </div>
        </>
      );

    case 'all':
    case 'any':
      return (
        <div className={panel.subFields}>
          {condition.of.map((child, index) => (
            // Keyed on the place, which is the only identity a child has: a condition carries no
            // id, and two identical children under one 'any' are a thing a person may write.
            <div key={index} className={panel.subField}>
              <Field
                label={`Condition ${index + 1}`}
                htmlFor={id(`of-${index}`)}
                /* At the head of the card, where every closable thing in this console puts its
                   close — and named for the child it removes, since the mark itself says nothing
                   about which of three it belongs to when it is read out of context. */
                aside={
                  <button
                    type="button"
                    className={panel.subRemove}
                    aria-label={`Remove condition ${index + 1}`}
                    title="Remove this condition"
                    onClick={() =>
                      onChange({ ...condition, of: condition.of.filter((_, at) => at !== index) })
                    }
                  >
                    ×
                  </button>
                }
              >
                <select
                  id={id(`of-${index}`)}
                  value={child.type === 'opaque' ? '' : child.type}
                  onChange={(event) =>
                    onChange({
                      ...condition,
                      of: condition.of.map((one, at) =>
                        at === index ? blankCondition(event.target.value as ConditionType) : one,
                      ),
                    })
                  }
                >
                  {child.type === 'opaque' && <option value="">As the file has it</option>}
                  {/* The composites are not offered. The union is recursive and the server takes
                      any depth; a tree editor inside a floating window is another feature, and the
                      one thing this form must never do is offer what it then cannot draw. */}
                  {SIMPLE_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {CONDITION_LABELS[type]}
                    </option>
                  ))}
                </select>
              </Field>

              <ConditionSummary type={child.type} />

              <ConditionFields
                condition={child}
                id={(name) => id(`of-${index}-${name}`)}
                source={source}
                onChange={(next) =>
                  onChange({
                    ...condition,
                    of: condition.of.map((one, at) => (at === index ? next : one)),
                  })
                }
              />
            </div>
          ))}

          <button
            type="button"
            onClick={() =>
              onChange({ ...condition, of: [...condition.of, blankCondition('threshold')] })
            }
          >
            Add a condition
          </button>
        </div>
      );

    case 'opaque':
      return (
        <>
          <pre className={panel.note} data-testid="condition-source">
            {conditionText(condition)}
          </pre>
          <p className={panel.note}>
            This console cannot draw this condition — it is deeper than this form goes, or it comes
            from a newer build. It is shown as the file has it and saved exactly as it stands.
          </p>
        </>
      );
  }
}

/** What the sample size is for, behind the mark beside it. */
function SampleHelp() {
  return (
    <>
      <p>
        How many of the most recent readings the engine keeps for each topic. This condition is
        judged on those readings and nothing older.
      </p>
      <p>
        It is a number of readings, not a length of time. At one reading every 10 seconds, 200
        readings cover about 33 minutes; at one a second, about 3 minutes.
      </p>
      <p>
        A smaller sample reacts sooner and is easier to mislead. A larger one is steadier and
        slower to notice a change. From 20 to 2000; leave it empty for the server&rsquo;s default.
      </p>
    </>
  );
}

/**
 * The one field four conditions share, worded once.
 *
 * It was 'Readings in the window', and 'window' is the engine's word for it: a reader who has not
 * met a sliding window has no way to tell from the label that this is how much history the test
 * looks at, or that it is a count and not a duration. The label now says what the number is, the
 * placeholder says what leaving it empty does, and the reason it matters is behind the mark.
 *
 * No longer `narrow`: the explanation opens inside the field, and a 96px column is not somewhere
 * three sentences can be read.
 */
function WindowField({
  window,
  id,
  onChange,
}: {
  window: string;
  id: (name: string) => string;
  onChange: (window: string) => void;
}) {
  return (
    <Field label="Sample size (readings)" htmlFor={id('window')} help={<SampleHelp />}>
      <input
        id={id('window')}
        value={window}
        inputMode="numeric"
        // The server's own default, and saying so is what makes the empty box a choice rather
        // than a field somebody forgot.
        placeholder="default: 200"
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}
