import { useId, useState } from 'react';
import { Field } from '../../components/Field';
import panel from '../../styles/panel.module.css';
import { runFor, useLogStore, type LogEntry } from '../../stores/logStore';
import { compilePattern, entryKey, recentTexts, verdictOf, type Verdict } from './patternVerdict';
import styles from './PatternTry.module.css';

/** The rule's topic filter and field, which decide what a pattern is tried against. */
export type PatternSource = { filter: string; field: string };

const WORDS: Record<Verdict, string> = {
  fires: 'fires',
  quiet: 'no',
  skipped: 'skipped — field missing',
};

const read = (filter: string): LogEntry[] =>
  filter.trim() === '' ? [] : runFor(useLogStore.getState().byTopic, filter.trim());

/**
 * A pattern, tried on what the rule's topics have already said and on whatever the reader types.
 *
 * The rows follow the rule's own topic filter — Use on a library example, then changing the topic
 * to the reader's own, must not go on showing the example's (empty) messages — but not arriving
 * traffic: a busy topic would otherwise move every row under the reader's eye between one keystroke
 * and the next, and the question being asked — does this expression say what I mean — is about the
 * expression, not about what arrived in the last second. So the messages are read again whenever
 * the filter itself changes, and otherwise only on Refresh.
 */
export function PatternTry({
  regex,
  negate,
  source,
}: {
  regex: string;
  negate: boolean;
  source: PatternSource;
}) {
  // Read during render rather than in an effect: an effect depending on `source` would fire on
  // every render (a fresh object each time), and one depending on `source.filter` would still
  // leave one render showing the old filter's rows before it caught up. Comparing the filter
  // that produced `entries` to today's `source.filter`, and re-reading inline when they differ,
  // means the rows shown are never behind the filter that is actually on screen.
  const [state, setState] = useState(() => ({ filter: source.filter, entries: read(source.filter) }));
  if (state.filter !== source.filter) {
    setState({ filter: source.filter, entries: read(source.filter) });
  }
  const entries = state.entries;
  const [own, setOwn] = useState('');
  const ownId = useId();

  const compiled = compilePattern(regex);
  const rows = recentTexts(entries, source.field);
  const wild = /[+#]/.test(source.filter);
  // An empty expression matches everything and judges nothing; the form already says it is needed.
  const judge = (text: string | null): Verdict | null =>
    compiled.ok && regex !== '' ? verdictOf(compiled.regex, negate, text) : null;
  const ownVerdict = own === '' ? null : judge(own);

  return (
    <section aria-label="Try the pattern" className={styles.try}>
      <div className={styles.head}>
        <span className={styles.title}>Try it</span>
        <button
          type="button"
          onClick={() => setState({ filter: source.filter, entries: read(source.filter) })}
        >
          Refresh
        </button>
      </div>

      {!compiled.ok ? (
        <p className={panel.fault}>Not a valid expression: {compiled.message}</p>
      ) : rows.length === 0 ? (
        <p className={panel.note}>No messages on this topic yet — type one below.</p>
      ) : (
        <ul className={styles.rows}>
          {rows.map((row) => {
            const verdict = judge(row.text);

            return (
              <li
                key={entryKey(row.topic, row.text)}
                className={styles.row}
                data-testid="try-row"
                data-verdict={verdict ?? ''}
              >
                {wild && <span className={styles.topic}>{row.topic}</span>}
                <span className={styles.text}>{row.text ?? '—'}</span>
                <span className={styles.verdict} data-verdict={verdict ?? ''}>
                  {verdict ? WORDS[verdict] : ''}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <Field label="Try your own text" htmlFor={ownId}>
        <div className={styles.own}>
          <input
            id={ownId}
            value={own}
            spellCheck={false}
            onChange={(event) => setOwn(event.target.value)}
          />
          <span className={styles.verdict} data-testid="own-verdict" data-verdict={ownVerdict ?? ''}>
            {ownVerdict ? WORDS[ownVerdict] : ''}
          </span>
        </div>
      </Field>
    </section>
  );
}
