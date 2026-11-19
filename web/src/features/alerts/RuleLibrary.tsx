import { useId, useState } from 'react';
import { InfoMark } from '../../components/InfoTip';
import panel from '../../styles/panel.module.css';
import styles from './RuleLibrary.module.css';
import { CONDITION_LABELS, ruleOf, type DraftRule } from './ruleDraft';
import { firesOn } from './ruleSummary';
import { TEMPLATES, type RuleTemplate } from './templates';

/**
 * One example of every kind of rule, to start from.
 *
 * It is offered beside New rule and never in front of it: somebody who knows what they want
 * presses New rule and gets an empty form, and somebody who does not can come here, read eleven
 * cards and leave with a rule that already works on somebody's garage.
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
  // One story at a time: the mark is a question about one card, and eleven answers open at once
  // is the page of prose the cards were made to avoid.
  const [told, setTold] = useState<RuleTemplate['type'] | null>(null);

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

      <ul className={styles.cards}>
        {TEMPLATES.map((template) => (
          <Card
            key={template.type}
            template={template}
            open={told === template.type}
            onTell={() => setTold((now) => (now === template.type ? null : template.type))}
            onUse={() => onUse(template.draft())}
          />
        ))}
      </ul>
    </section>
  );
}

function Card({
  template,
  open,
  onTell,
  onUse,
}: {
  template: RuleTemplate;
  open: boolean;
  onTell: () => void;
  onUse: () => void;
}) {
  const storyId = useId();
  const label = CONDITION_LABELS[template.type];
  // Read off the draft the card would hand over, in the words the rules table uses, so the
  // example on the card and the row it turns into cannot say two different things.
  const rule = ruleOf(template.draft());

  return (
    <li className={styles.card} data-testid="rule-template">
      <div className={styles.cardHead}>
        <h4 className={styles.kind}>{label}</h4>
        <InfoMark label={label} open={open} controls={open ? storyId : undefined} onToggle={onTell} />
      </div>

      {open ? (
        <div id={storyId} className={styles.story} role="note">
          <span className={styles.storyLabel}>Real example</span>
          <p>{template.story}</p>
        </div>
      ) : (
        <>
          <p className={styles.says}>{template.says}</p>
          <div className={styles.example}>
            <span className={styles.exampleTopic}>{rule.filter}</span>
            <span>{firesOn(rule)}</span>
          </div>
        </>
      )}

      <button
        type="button"
        className={styles.use}
        aria-label={`Use the ${label} template`}
        onClick={onUse}
      >
        Use
      </button>
    </li>
  );
}
