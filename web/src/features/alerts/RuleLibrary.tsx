import { useId, useState } from 'react';
import { InfoMark } from '../../components/InfoTip';
import { Segmented } from '../../components/Segmented';
import { duration } from '../../lib/format';
import panel from '../../styles/panel.module.css';
import type { AlertRuleDto } from '../../types/api';
import styles from './RuleLibrary.module.css';
import { CONDITION_LABELS, ruleOf, type ConditionType, type DraftRule } from './ruleDraft';
import { firesOn } from './ruleSummary';
import { TEMPLATE_GROUPS, type RuleExample } from './templates';

/** Conditions whose window is 'how many readings', shown when the example actually sets one. */
const WINDOWED = new Set(['outlier', 'distributionShift', 'shapeChange', 'pulse']);

/**
 * The card's own line: `firesOn`, plus whatever it leaves out that a card is here to teach.
 *
 * `firesOn` is the rules table's cell, and a cell has to stay one clause for every kind of
 * condition — that is what makes thirty rules scannable as a column. A card is one rule and has
 * the room to say what actually makes it: how long it has to hold, where it clears, how large a
 * sample it is judged against, or — for `all`/`any` — what each child actually tests, rather than
 * how many of them there are.
 */
function cardLine(rule: AlertRuleDto): string {
  const { condition } = rule;

  let line =
    condition.type === 'all' || condition.type === 'any'
      ? condition.of
          .map((child) => firesOn({ ...rule, condition: child }))
          .join(condition.type === 'all' ? ' AND ' : ' OR ')
      : firesOn(rule);

  if (rule.for) line += ` · for ${duration(rule.for * 1000)}`;
  if (rule.clear) line += ` · clears at ${firesOn({ ...rule, condition: rule.clear })}`;

  if (WINDOWED.has(condition.type) && 'window' in condition && condition.window) {
    line += ` · last ${condition.window} readings`;
  }

  return line;
}

/**
 * A worked example of every setting of every kind of rule, to start from.
 *
 * It is offered beside New rule and never in front of it: somebody who knows what they want
 * presses New rule and gets an empty form, and somebody who does not can come here and leave with
 * a rule that already works on somebody's garage.
 *
 * One kind at a time, and none until one is picked. Thirty-odd cards on one page is a page read
 * by scrolling past most of it; the eleven names fit on two lines, and the reader who came here
 * knowing they want a silence rule sees only the silence rules. The kind's one line stands under
 * the picker, where Segmented puts a note about the chosen option.
 *
 * Every card is the same size, and stays that size when its mark is pressed — the example gives
 * way to the story rather than the card growing under it. A grid whose cards change height is a
 * grid whose other cards move while they are being read.
 */
export function RuleLibrary({
  onUse,
  onBlank,
  onBack,
}: {
  onUse: (draft: DraftRule) => void;
  onBlank: () => void;
  onBack: () => void;
}) {
  const [kind, setKind] = useState<ConditionType | null>(null);
  // One story at a time: the mark is a question about one card, and a page of answers open at
  // once is the prose the cards were made to avoid.
  const [told, setTold] = useState<string | null>(null);
  const name = useId();

  const group = TEMPLATE_GROUPS.find((one) => one.type === kind) ?? null;

  return (
    <section aria-label="Rule library" className={styles.library}>
      <div className={panel.sectionTop}>
        <h3 className={panel.screenTitle}>Rule library</h3>

        <div className={styles.ways}>
          <button type="button" onClick={onBack}>
            &larr; Back
          </button>
          <button type="button" onClick={onBlank}>
            Blank rule
          </button>
        </div>
      </div>

      <Segmented
        label="Kind of rule"
        name={name}
        options={TEMPLATE_GROUPS.map((one) => ({ value: one.type, label: CONDITION_LABELS[one.type] }))}
        value={kind}
        onChange={(picked) => {
          setKind(picked);
          setTold(null);
        }}
        note={group?.says}
      />

      {group === null ? (
        <p className={panel.note}>Pick a kind to see its examples.</p>
      ) : (
        <ul className={styles.cards} aria-label={`${CONDITION_LABELS[group.type]} examples`}>
          {group.examples.map((example) => (
            <Card
              key={example.title}
              example={example}
              label={CONDITION_LABELS[group.type]}
              open={told === example.title}
              onTell={() => setTold((now) => (now === example.title ? null : example.title))}
              onUse={() => onUse(example.draft())}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function Card({
  example,
  label,
  open,
  onTell,
  onUse,
}: {
  example: RuleExample;
  label: string;
  open: boolean;
  onTell: () => void;
  onUse: () => void;
}) {
  const storyId = useId();
  // Read off the draft the card would hand over, in the words the rules table uses, so the
  // example on the card and the row it turns into cannot say two different things.
  const rule = ruleOf(example.draft());

  return (
    <li className={styles.card} data-testid="rule-template">
      <div className={styles.cardHead}>
        <h5 className={styles.title}>{example.title}</h5>
        <InfoMark
          label={example.title}
          open={open}
          controls={open ? storyId : undefined}
          onToggle={onTell}
        />
      </div>

      {open ? (
        <div id={storyId} className={styles.story} role="note">
          <span className={styles.storyLabel}>Real example</span>
          <p>{example.story}</p>
        </div>
      ) : (
        <div className={styles.example}>
          <span className={styles.exampleTopic}>{rule.filter}</span>
          <span>{cardLine(rule)}</span>
        </div>
      )}

      <button
        type="button"
        className={styles.use}
        aria-label={`Use the ${example.title} example (${label})`}
        onClick={onUse}
      >
        Use
      </button>
    </li>
  );
}
