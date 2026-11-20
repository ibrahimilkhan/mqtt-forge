import { useId, useRef, useState } from 'react';
import { InfoMark } from '../../components/InfoTip';
import panel from '../../styles/panel.module.css';
import styles from './RuleLibrary.module.css';
import { CONDITION_LABELS, ruleOf, type ConditionType, type DraftRule } from './ruleDraft';
import { firesOn } from './ruleSummary';
import { TEMPLATE_GROUPS, type RuleExample } from './templates';

/**
 * A worked example of every setting of every kind of rule, to start from.
 *
 * It is offered beside New rule and never in front of it: somebody who knows what they want
 * presses New rule and gets an empty form, and somebody who does not can come here and leave with
 * a rule that already works on somebody's garage.
 *
 * Grouped under the kind, with the kind said once at its head, and a row of chips at the top to
 * reach a kind without scrolling past thirty cards. Every card is the same size, and stays that
 * size when its mark is pressed — the example gives way to the story rather than the card growing
 * under it. A grid whose cards change height is a grid whose other cards move while they are
 * being read.
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
  // One story at a time across the whole library: the mark is a question about one card, and a
  // page of answers open at once is the prose the cards were made to avoid.
  const [told, setTold] = useState<string | null>(null);
  const headings = useRef(new Map<ConditionType, HTMLHeadingElement>());
  const base = useId();

  const jump = (type: ConditionType) => {
    const heading = headings.current.get(type);
    // Optional because jsdom has no scrolling; focus is what a keyboard reader is moved by anyway.
    heading?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    heading?.focus({ preventScroll: true });
  };

  return (
    <section aria-label="Rule library">
      <div className={panel.sectionTop}>
        <h3 className={panel.sectionTitle}>Rule library</h3>

        <div className={styles.ways}>
          <button type="button" onClick={onBack}>
            &larr; Back
          </button>
          <button type="button" onClick={onBlank}>
            Blank rule
          </button>
        </div>
      </div>

      <nav aria-label="Kinds of rule" className={styles.kinds}>
        {TEMPLATE_GROUPS.map((group) => (
          <button
            key={group.type}
            type="button"
            className={styles.kindChip}
            onClick={() => jump(group.type)}
          >
            {CONDITION_LABELS[group.type]}
          </button>
        ))}
      </nav>

      {TEMPLATE_GROUPS.map((group) => {
        const label = CONDITION_LABELS[group.type];
        const headingId = `${base}-${group.type}`;

        return (
          <section key={group.type} aria-labelledby={headingId} className={styles.group}>
            <div className={styles.groupHead}>
              <h4
                id={headingId}
                tabIndex={-1}
                className={styles.kind}
                ref={(element) => {
                  if (element) headings.current.set(group.type, element);
                  else headings.current.delete(group.type);
                }}
              >
                {label}
              </h4>
              <p className={styles.says}>{group.says}</p>
            </div>

            <ul className={styles.cards}>
              {group.examples.map((example) => {
                const key = `${group.type}:${example.title}`;

                return (
                  <Card
                    key={key}
                    example={example}
                    label={label}
                    open={told === key}
                    onTell={() => setTold((now) => (now === key ? null : key))}
                    onUse={() => onUse(example.draft())}
                  />
                );
              })}
            </ul>
          </section>
        );
      })}
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
          <span>{firesOn(rule)}</span>
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
