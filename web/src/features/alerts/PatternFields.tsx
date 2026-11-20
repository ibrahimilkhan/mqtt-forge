import { useState } from 'react';
import { Field } from '../../components/Field';
import panel from '../../styles/panel.module.css';
import {
  modeOf,
  PATTERN_MODES,
  readPattern,
  regexOf,
  switchMode,
  typedIn,
  type PatternMode,
} from './patternBuilder';
import { PatternTry, type PatternSource } from './PatternTry';
import type { DraftCondition } from './ruleDraft';

type Pattern = Extract<DraftCondition, { type: 'pattern' }>;

/**
 * A pattern written in words, with the expression they make shown under them and tried below.
 *
 * The draft holds the expression and nothing else, as the rule file does; the mode is this form's
 * own, and `modeOf` reconciles the two on every render. That is what lets a template or a reload
 * replace the expression without an effect chasing it: the form draws whatever the expression
 * now says.
 */
export function PatternFields({
  condition,
  onChange,
  id,
  source,
}: {
  condition: Pattern;
  onChange: (condition: DraftCondition) => void;
  id: (name: string) => string;
  source: PatternSource;
}) {
  const [chosen, setChosen] = useState<PatternMode>(() => readPattern(condition.regex).mode);
  const mode = modeOf(chosen, condition.regex);
  const text = typedIn(mode, condition.regex);

  const write = (typed: string) =>
    onChange({ ...condition, regex: mode === 'regex' ? typed : regexOf(mode, typed) });

  return (
    <>
      <div className={panel.row}>
        <Field label="How it matches" htmlFor={id('mode')}>
          <select
            id={id('mode')}
            value={mode}
            onChange={(event) => {
              const next = event.target.value as PatternMode;

              setChosen(next);
              onChange({ ...condition, regex: switchMode(condition.regex, mode, next) });
            }}
          >
            {PATTERN_MODES.map((one) => (
              <option key={one.value} value={one.value}>
                {one.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Fire when" htmlFor={id('negate')}>
          <select
            id={id('negate')}
            value={condition.negate ? 'miss' : 'match'}
            onChange={(event) => onChange({ ...condition, negate: event.target.value === 'miss' })}
          >
            <option value="match">it matches</option>
            <option value="miss">it does not match</option>
          </select>
        </Field>
      </div>

      {/* One box for every mode: only its name and its hint change with it. */}
      <Field
        label={mode === 'regex' ? 'Expression' : 'Text'}
        htmlFor={id(mode === 'regex' ? 'regex' : 'text')}
      >
        <input
          id={id(mode === 'regex' ? 'regex' : 'text')}
          value={text}
          spellCheck={false}
          placeholder={mode === 'regex' ? '^ERR-[0-9]+' : undefined}
          onChange={(event) => write(event.target.value)}
        />
      </Field>

      {/* The expression the words make, so a reader learns the syntax by watching it written —
          and can switch to Regular expression to take it further from there. */}
      {mode !== 'regex' && condition.regex !== '' && (
        <p className={panel.note} data-testid="pattern-regex">
          Saved as <code>{condition.regex}</code>
        </p>
      )}

      <PatternTry regex={condition.regex} negate={condition.negate} source={source} />
    </>
  );
}
