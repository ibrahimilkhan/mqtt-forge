import { Field } from '../../components/Field';
import panel from '../../styles/panel.module.css';
import type { OutlierMethod, PulseMetric, ThresholdOp } from '../../types/api';
import {
  blankCondition,
  conditionText,
  CONDITION_LABELS,
  defaultK,
  SIMPLE_TYPES,
  type ConditionType,
  type DraftCondition,
} from './ruleDraft';

/** The words for the six operators. '≠' is drawn rather than spelled: it is read at a glance. */
const OPS: ReadonlyArray<{ value: ThresholdOp; label: string }> = [
  { value: 'gt', label: '>' },
  { value: 'gte', label: '≥' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '≤' },
  { value: 'eq', label: '=' },
  { value: 'neq', label: '≠' },
];

const METRICS: ReadonlyArray<{ value: PulseMetric; label: string }> = [
  { value: 'count', label: 'excursions in the window' },
  { value: 'duty', label: 'share of readings past the line' },
  { value: 'period', label: 'milliseconds between excursions' },
  { value: 'width', label: 'milliseconds an excursion lasts' },
];

type Props = {
  condition: DraftCondition;
  onChange: (condition: DraftCondition) => void;
  /** The window's own id maker, so two editors open at once do not share a field. */
  id: (name: string) => string;
};

/**
 * The parameters of one condition, and only of that one.
 *
 * Eleven forms rather than one form with every box on it and most of them greyed out: a reader
 * choosing 'nothing has arrived' is choosing a rule with one number in it, and eight disabled
 * fields underneath would be eight questions they have to read before deciding they are not being
 * asked them.
 *
 * Controlled all the way down. Nothing here holds state of its own — every keystroke goes out
 * through `onChange` and comes back as a new `condition` — which is what lets the editor keep one
 * draft in one place and write it through to the map on every change.
 */
export function ConditionFields({ condition, onChange, id }: Props) {
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
          <p className={panel.note}>
            {condition.inside
              ? 'Fires while the reading is between the two edges, both of them included.'
              : 'Fires when the reading leaves the range — the 4-20mA question.'}
          </p>
        </>
      );

    case 'pattern':
      return (
        <>
          <Field label="Expression" htmlFor={id('regex')}>
            <input
              id={id('regex')}
              value={condition.regex}
              spellCheck={false}
              placeholder="^ERR-[0-9]+"
              onChange={(event) => onChange({ ...condition, regex: event.target.value })}
            />
          </Field>
          <div className={panel.checks}>
            <label>
              <input
                type="checkbox"
                checked={condition.negate}
                onChange={(event) => onChange({ ...condition, negate: event.target.checked })}
              />
              Fire when it does NOT match
            </label>
          </div>
        </>
      );

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
              ? 'k multiplies the interquartile range — the box. 1.5 is the textbook fence; the range is 0.5 to 5.'
              : 'k is a number of deviations. 3 is what every control chart is drawn at; the range is 1 to 10.'}
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
            Fires once, at the moment the readings settle into a different distribution — so there
            is nothing here for 'For' to wait out, and it cannot be given with one.
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
            Fires once, when a quantity becomes a switch or a switch becomes a pulse train — which
            is the plant saying that whatever was written about this topic now describes something
            else.
          </p>
        </>
      );

    case 'pulse':
      return (
        <>
          <Field label="Metric" htmlFor={id('metric')}>
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
          {condition.metric === 'duty' && (
            <p className={panel.note}>A duty is a share of the readings, from 0 to 1.</p>
          )}
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
              <Field label={`Condition ${index + 1}`} htmlFor={id(`of-${index}`)}>
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

              <ConditionFields
                condition={child}
                id={(name) => id(`of-${index}-${name}`)}
                onChange={(next) =>
                  onChange({
                    ...condition,
                    of: condition.of.map((one, at) => (at === index ? next : one)),
                  })
                }
              />

              <button
                type="button"
                className="ghost"
                onClick={() =>
                  onChange({ ...condition, of: condition.of.filter((_, at) => at !== index) })
                }
              >
                Remove condition {index + 1}
              </button>
            </div>
          ))}

          <button
            type="button"
            className="ghost"
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

/** The one field three conditions share, worded once. */
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
    <Field label="Readings in the window" htmlFor={id('window')} narrow>
      <input
        id={id('window')}
        value={window}
        inputMode="numeric"
        // The server's own default, and saying so is what makes the empty box a choice rather
        // than a field somebody forgot.
        placeholder="200"
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}
