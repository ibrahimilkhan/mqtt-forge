import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type ReactNode } from 'react';
import { getAlertRules, putAlertRules } from '../../api/alerts';
import { queryKeys } from '../../api/queryKeys';
import { Field } from '../../components/Field';
import { InfoBody, InfoMark, Example } from '../../components/InfoTip';
import { QosSelect } from '../../components/QosSelect';
import { Segmented } from '../../components/Segmented';
import { Braces, Search } from '../brand/icons';
import { useGuardedMutate } from '../../lib/useGuardedMutate';
import { logFault, useLogStore } from '../../stores/logStore';
import panel from '../../styles/panel.module.css';
import styles from './RuleEditor.module.css';
import type { AlertRuleDto, AlertRulesResponseDto, AlertSeverity } from '../../types/api';
import { ConditionFields, ConditionSummary } from './ConditionFields';
import { FieldPicker } from './FieldPicker';
import { TopicPicker } from './TopicPicker';
import {
  blankCondition,
  CONDITION_LABELS,
  CONDITION_TYPES,
  draftOf,
  faultsIn,
  forgetDraft,
  keepDraft,
  readDraft,
  retypeCondition,
  ruleOf,
  savable,
  saveRule,
  type ConditionType,
  type DraftRule,
  type SaveTarget,
} from './ruleDraft';

/**
 * One alert rule, in the alerts panel, in place of the rule list.
 *
 * It was a window for a while, and for a good reason: ten condition types with their own
 * parameters, four modifiers and four channels in a 320px column is one field to a line and a
 * scrolling tunnel to fill it in. The panel takes the whole workspace now, so the room the window
 * was opened for is here — three groups side by side rather than one column of forty fields.
 *
 * The draft lives in `ruleDraft`, and this holds a copy in state only so React redraws. Every
 * change writes through, which is what lets the panel ask 'this has been filled in — leave it?'
 * without this component knowing anything about the question.
 */
export function RuleEditor({
  draftId,
  onDone,
  onBack,
}: {
  draftId: string;
  /** The server has the rule. */
  onDone: () => void;
  /**
   * The way out without saving — the panel's own, which asks first when the draft has been
   * filled in. Required rather than optional: a form with a Save and no way back is a trap, and
   * an optional prop is one a caller forgets.
   */
  onBack: () => void;
}) {
  const queryClient = useQueryClient();
  // Read, not written to. The list has one owner — this cache — and the editor's job at the click
  // is to hand it back the same list with one rule changed. What is wanted from it here is the two
  // facts only the server knows: where it publishes, and whether it posts webhooks at all.
  const { data } = useQuery({ queryKey: queryKeys.alertRules, queryFn: getAlertRules });

  const [draft, setDraft] = useState<DraftRule>(
    // The map is the source. The fallback is unreachable through `startRuleDraft`, which makes the
    // draft before the panel draws the editor, and exists so a draft that has been forgotten under
    // us draws a blank form rather than throwing inside a render.
    () => readDraft(draftId) ?? draftOf(undefined, undefined),
  );

  const edit = (change: Partial<DraftRule>) =>
    setDraft((current) => keepDraft(draftId, { ...current, ...change }));

  /**
   * A field id of this window's own.
   *
   * Only one editor is open at a time now that it lives in the panel, so this is no longer load
   * bearing — but an id that is unique per draft costs nothing and is the difference between a
   * label that focuses its own box and one that focuses whatever else answered to the same name.
   * The draft id carries a colon and a rule id may carry a dash, so it is reduced to what an id is
   * safely made of.
   */
  const id = (name: string) => `${draftId.replace(/[^a-z0-9]+/gi, '-')}-${name}`;

  // The defaults are this server's own, and they are only in force for the moment before the GET
  // lands: a form that refused every publish topic while the document was in flight would be a
  // form that says no to a reader who has done nothing wrong.
  const where: SaveTarget = {
    topicPrefix: data?.topicPrefix ?? 'mqttforge/alerts/',
    allowWebhooks: data?.allowWebhooks ?? true,
  };
  const faults = faultsIn(draft, where);

  const save = useMutation({
    // Never discardUnreadable: a rules file the server could not read is a record, and an editor
    // that overwrote it would delete rules nobody has seen. The panel is where that decision is
    // offered, with the count of what would go.
    mutationFn: (rules: AlertRuleDto[]) => putAlertRules(rules, false),
    onSuccess: (result) => {
      const warning = result.warnings.find((one) => one.ruleId === draft.id);

      useLogStore.getState().push({
        kind: 'ok',
        verb: 'Alert rule saved',
        topic: draft.name.trim() || draft.filter.trim(),
        // Saved and warned is a real answer — 'this server has webhooks turned off' — and the log
        // is where the console's own actions are explained.
        body: warning?.reason,
      });

      queryClient.setQueryData(queryKeys.alertRules, (held?: AlertRulesResponseDto) =>
        held ? { ...held, rules: result.rules } : held,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.alertRules });

      // The draft has become a rule. The next Edit on this row reads what the server holds, ids
      // and all, rather than the copy that was being typed into.
      forgetDraft(draftId);
      onDone();
    },
    // The draft is left exactly as it was: what was typed is the only copy of it.
    onError: (error) => logFault('Alert rule not saved', error, draft.filter.trim()),
  });

  const guardedSave = useGuardedMutate(save);

  /**
   * Which of the two pickers is open, if either.
   *
   * One at a time, and held here rather than one flag per picker: they fill in fields that sit
   * two rows apart in the same column, and both open at once would push the second one's own
   * field off the bottom of the panel — the reader would be looking at a list of paths with the
   * box it fills in nowhere on screen.
   */
  const [picking, setPicking] = useState<'topic' | 'field' | null>(null);
  const toggle = (which: 'topic' | 'field') =>
    setPicking((open) => (open === which ? null : which));

  // The one switch on this form whose name cannot say what leaving it off does.
  const [clearHelp, setClearHelp] = useState(false);
  const clearHelpId = useId();

  return (
    <form className={styles.form} onSubmit={(event) => event.preventDefault()}>
      {/* The three panels are a grid of their own, and the button row is NOT in it. That is not
          tidiness — it is the whole reason the form used to leave a quarter of the panel empty.
          See the note in RuleEditor.module.css. */}
      <div className={styles.columns}>
      <Part
        title="What it watches"
        help={<WatchesHelp />}
      >
        <div className={panel.row}>
          <Field label="Name" htmlFor={id('name')}>
            <input
              id={id('name')}
              value={draft.name}
              maxLength={80}
              placeholder="Boiler temperature"
              aria-invalid={faults.name !== undefined}
              onChange={(event) => edit({ name: event.target.value })}
            />
          </Field>

          <Field
            label="Topic filter"
            htmlFor={id('filter')}
            /* The one field on this form the console already knows the answer to. */
            aside={
              <PickMark
                label="topics on the broker"
                open={picking === 'topic'}
                onToggle={() => toggle('topic')}
              >
                <Search />
              </PickMark>
            }
          >
            <input
              id={id('filter')}
              value={draft.filter}
              spellCheck={false}
              placeholder="plant/+/temp"
              aria-invalid={faults.filter !== undefined}
              onChange={(event) => edit({ filter: event.target.value })}
            />
          </Field>
        </div>

        {picking === 'topic' && (
          <TopicPicker
            onPick={(filter) => {
              edit({ filter });
              setPicking(null);
            }}
            onClose={() => setPicking(null)}
          />
        )}

        {faults.name && <p className={panel.fault}>{faults.name}</p>}
        {faults.filter && <p className={panel.fault}>{faults.filter}</p>}

        <Field
          label="Field"
          htmlFor={id('field')}
          aside={
            <PickMark
              label="fields in a message"
              open={picking === 'field'}
              onToggle={() => toggle('field')}
            >
              <Braces />
            </PickMark>
          }
          help={<FieldHelp />}
        >
          <input
            id={id('field')}
            value={draft.field}
            spellCheck={false}
            placeholder="the whole message body"
            onChange={(event) => edit({ field: event.target.value })}
          />
        </Field>

        {picking === 'field' && (
          <FieldPicker
            filter={draft.filter}
            onPick={(field) => {
              edit({ field });
              setPicking(null);
            }}
            onClose={() => setPicking(null)}
          />
        )}

        <div className={styles.severity}>
          <Segmented
            label="Severity"
            name={id('severity')}
            value={draft.severity}
            options={[
              { value: 'info', label: 'info' },
              { value: 'warn', label: 'warn' },
              { value: 'critical', label: 'critical' },
            ]}
            onChange={(severity) => edit({ severity: severity as AlertSeverity })}
            /* The level used to decide how long a notice survived in the corner — six seconds for
               a warning, until dismissed for a critical. Nothing fades and nothing is dismissed
               any more, so what is left for the level to decide is where the alarm stands in the
               panel, and which level the rail's count wears while it is up. */
            note={
              draft.severity === 'critical'
                ? 'A critical alarm stands at the top of the Alerts panel while it is alarming.'
                : 'An info or warn alarm stands below the criticals while it is alarming.'
            }
          />
        </div>
      </Part>

      <Part
        title="When it fires"
        help={<FiresHelp />}
      >
        <Field label="Condition" htmlFor={id('condition')}>
          <select
            id={id('condition')}
            value={draft.condition.type === 'opaque' ? '' : draft.condition.type}
            onChange={(event) =>
              edit({
                condition: retypeCondition(draft.condition, event.target.value as ConditionType),
              })
            }
          >
            {/* A condition this form cannot draw is a real state and it needs a place in the
                picker to sit, or the select would silently show whatever option happens to be
                first and read as a rule that says something it does not. */}
            {draft.condition.type === 'opaque' && <option value="">As the file has it</option>}
            {CONDITION_TYPES.map((type) => (
              <option key={type} value={type}>
                {CONDITION_LABELS[type]}
              </option>
            ))}
          </select>
        </Field>

        <ConditionSummary type={draft.condition.type} />

        <ConditionFields
          condition={draft.condition}
          id={(name) => id(`condition-${name}`)}
          onChange={(condition) => edit({ condition })}
        />
        {faults.condition && <p className={panel.fault}>{faults.condition}</p>}

        {/* 'Clear on a condition of its own' was a nine-word instruction sitting where a switch's
            name goes, and it still did not say the thing worth saying — which is what happens
            when it is left off. Three words and a mark: the sentence moved behind the mark, where
            a reader who needs it can find it and a reader who does not is looking at a switch. */}
        <div className={panel.checks}>
          <span className={styles.checkWithInfo}>
            <label>
              <input
                type="checkbox"
                checked={draft.clear !== null}
                onChange={(event) =>
                  edit({ clear: event.target.checked ? blankCondition('threshold') : null })
                }
              />
              Its own clear rule
            </label>
            {/* Outside the label on purpose: inside it, a press on the mark would toggle the
                checkbox — a control that changes the rule when you ask it what it does. */}
            <InfoMark
              label="its own clear rule"
              open={clearHelp}
              controls={clearHelpId}
              onToggle={() => setClearHelp((shown) => !shown)}
            />
          </span>
        </div>

        {/* Under the row rather than inside it. `.checks` is a flex line of switches, and a
            paragraph handed to it is laid out as a switch: two words wide and thirty lines tall. */}
        {clearHelp && (
          <InfoBody id={clearHelpId}>
            <ClearHelp />
          </InfoBody>
        )}

        {draft.clear && (
          <>
            <Field label="Clear when" htmlFor={id('clear')}>
              <select
                id={id('clear')}
                value={draft.clear.type === 'opaque' ? '' : draft.clear.type}
                onChange={(event) =>
                  edit({ clear: retypeCondition(draft.clear!, event.target.value as ConditionType) })
                }
              >
                {draft.clear.type === 'opaque' && <option value="">As the file has it</option>}
                {CONDITION_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {CONDITION_LABELS[type]}
                  </option>
                ))}
              </select>
            </Field>

            <ConditionSummary type={draft.clear.type} />

            <ConditionFields
              condition={draft.clear}
              id={(name) => id(`clear-${name}`)}
              onChange={(clear) => edit({ clear })}
            />
            {faults.clear && <p className={panel.fault}>{faults.clear}</p>}
          </>
        )}
      </Part>

      <Part
        title="Everything else"
        help={<ElseHelp />}
      >
      <div className={`${panel.row} ${styles.timing}`}>
        <Field label="For, seconds" htmlFor={id('for')} narrow>
          {/* Text rather than a number box, in every one of these. A number input silently throws
              away what it cannot parse, so a typo would vanish from under the reader's hand and the
              box would look like one they had cleared on purpose. And an empty box is a real
              answer here — 'the moment it is true' — which has to survive being typed into and
              emptied again. */}
          <input
            id={id('for')}
            value={draft.for}
            inputMode="numeric"
            placeholder="at once"
            aria-invalid={faults.for !== undefined}
            onChange={(event) => edit({ for: event.target.value })}
          />
        </Field>
        <Field label="Cooldown, seconds" htmlFor={id('cooldown')} narrow>
          <input
            id={id('cooldown')}
            value={draft.cooldown}
            inputMode="numeric"
            placeholder="1"
            aria-invalid={faults.cooldown !== undefined}
            onChange={(event) => edit({ cooldown: event.target.value })}
          />
        </Field>
      </div>

      {faults.for && <p className={panel.fault}>{faults.for}</p>}
      {faults.cooldown && <p className={panel.fault}>{faults.cooldown}</p>}


      <div className={panel.checks}>
        <label>
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => edit({ enabled: event.target.checked })}
          />
          Enabled
        </label>
        <label>
          <input
            type="checkbox"
            checked={draft.screen}
            onChange={(event) => edit({ screen: event.target.checked })}
          />
          Notice on screen
        </label>
        <label>
          <input
            type="checkbox"
            checked={draft.sound}
            onChange={(event) => edit({ sound: event.target.checked })}
          />
          Sound
        </label>
        <label>
          <input
            type="checkbox"
            checked={draft.webhook !== null}
            onChange={(event) =>
              edit({ webhook: event.target.checked ? { url: '', headers: [] } : null })
            }
          />
          Webhook
        </label>
        <label>
          <input
            type="checkbox"
            checked={draft.publish !== null}
            onChange={(event) =>
              edit({ publish: event.target.checked ? { topic: '', qos: 0, retain: false } : null })
            }
          />
          Publish
        </label>
      </div>

      {draft.webhook && (
        <>
          <Field label="Webhook address" htmlFor={id('url')}>
            <input
              id={id('url')}
              value={draft.webhook.url}
              spellCheck={false}
              placeholder="https://ops.example/hook"
              aria-invalid={faults.webhook !== undefined}
              onChange={(event) => edit({ webhook: { ...draft.webhook!, url: event.target.value } })}
            />
          </Field>

          {!where.allowWebhooks && (
            <p className={panel.note}>
              Webhooks are turned off on this server. The rule will save and the address will be
              kept, and nothing will be posted to it.
            </p>
          )}

          <div className={panel.subFields}>
            {draft.webhook.headers.map((header, index) => (
              <div key={index} className={panel.row}>
                <Field label={`Header ${index + 1} name`} htmlFor={id(`header-${index}-name`)}>
                  <input
                    id={id(`header-${index}-name`)}
                    value={header.name}
                    spellCheck={false}
                    onChange={(event) =>
                      edit({
                        webhook: {
                          ...draft.webhook!,
                          headers: draft.webhook!.headers.map((one, at) =>
                            at === index ? { ...one, name: event.target.value } : one,
                          ),
                        },
                      })
                    }
                  />
                </Field>
                <Field label={`Header ${index + 1} value`} htmlFor={id(`header-${index}-value`)}>
                  <input
                    id={id(`header-${index}-value`)}
                    type="password"
                    value={header.value}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={header.kept ? 'kept' : ''}
                    onChange={(event) =>
                      edit({
                        webhook: {
                          ...draft.webhook!,
                          headers: draft.webhook!.headers.map((one, at) =>
                            at === index ? { ...one, value: event.target.value } : one,
                          ),
                        },
                      })
                    }
                  />
                </Field>
                <button
                  type="button"
                  className="ghost"
                  onClick={() =>
                    edit({
                      webhook: {
                        ...draft.webhook!,
                        headers: draft.webhook!.headers.filter((_, at) => at !== index),
                      },
                    })
                  }
                >
                  Remove header {index + 1}
                </button>
              </div>
            ))}

            <button
              type="button"
              className="ghost"
              onClick={() =>
                edit({
                  webhook: {
                    ...draft.webhook!,
                    headers: [...draft.webhook!.headers, { name: '', value: '', kept: false }],
                  },
                })
              }
            >
              Add a header
            </button>
          </div>

          {/* Said plainly, because an empty box that means 'keep' is not a thing a form has ever
              meant before. The value never left the server, so there is nothing this console could
              show; and the value belongs to the address, so changing the address asks for it again. */}
          <p className={panel.note}>
            A header value stays on the server and is never sent to this console. Leave it empty to
            keep the one already stored. Change the address and the stored values are not carried
            over — they were issued for the old one.
          </p>

          {faults.webhook && <p className={panel.fault}>{faults.webhook}</p>}
        </>
      )}

      {draft.publish && (
        <>
          <Field label="Publish topic" htmlFor={id('topic')}>
            <input
              id={id('topic')}
              value={draft.publish.topic}
              spellCheck={false}
              placeholder="the server's own tree"
              aria-invalid={faults.publish !== undefined}
              onChange={(event) =>
                edit({ publish: { ...draft.publish!, topic: event.target.value } })
              }
            />
          </Field>

          <div className={panel.checks}>
            <QosSelect
              name={id('qos')}
              value={draft.publish.qos}
              onChange={(qos) => edit({ publish: { ...draft.publish!, qos } })}
            />
            <label>
              <input
                type="checkbox"
                checked={draft.publish.retain}
                onChange={(event) =>
                  edit({ publish: { ...draft.publish!, retain: event.target.checked } })
                }
              />
              Retain
            </label>
          </div>

          {faults.publish && <p className={panel.fault}>{faults.publish}</p>}
        </>
      )}

      </Part>
      </div>

      {/* The two ways out of a form, on the form's own last row.
 
          Back used to stand at the top of the panel, above the heading of the first column — the
          place a browser puts a back button, and the wrong place for this one: it is not
          navigation, it is the other answer to the question the Save button asks, and the two
          belong on the same line. It reads first because it is the smaller claim and the one a
          reader passes on the way to the other.

          There was a Close here once, and it went because it called onDone — the panel's 'forget
          the draft and go back' — so it threw away a filled-in rule without the question. This is
          not that button back again. onBack is the panel's own Back, which asks. */}
      <div className={`${panel.actions} ${styles.footer}`}>
        <button type="button" className="ghost" onClick={onBack}>
          &larr; Back
        </button>
        <button
          type="button"
          className={panel.trailing}
          disabled={!savable(faults) || save.isPending}
          onClick={() => {
            // Read at the click, and only here. Between this window opening and this press the
            // panel may have flipped a switch, deleted a rule, or another editor may have saved —
            // and a body compiled from anything older would quietly undo whichever of them was
            // first. `saveRule` puts this one rule into that list and changes nothing else.
            const held = queryClient.getQueryData<AlertRulesResponseDto>(queryKeys.alertRules);

            guardedSave(saveRule(held?.rules ?? [], ruleOf(draft)));
          }}
        >
          Save
        </button>
      </div>
    </form>
  );
}

/**
 * One of the three parts a rule is written in, with its own explanation folded behind a mark.
 *
 * The fieldset and legend are the point and not decoration: a screen reader announces the legend
 * with every control inside it, so 'Topic filter' is heard as 'What it watches, Topic filter' and
 * a reader who tabbed into the middle of a long form still knows which third of it they are in.
 *
 * The help hangs off the heading rather than off the fields. Twelve fields with a paragraph each
 * is a form nobody can find anything in — that is what this one was becoming — and the questions
 * a reader actually has are about the group ('what is a clear rule for?', 'what does For do?'),
 * not about the box. One mark per part answers them where they are asked, and the form underneath
 * stays a form.
 *
 * There was a summary line under each heading too — 'the rule's name, the topics it covers, and
 * how loudly it speaks' — and it went for the same reason the field prose went. Three headings
 * over three columns of labelled boxes say what the columns hold; a sentence restating it is a
 * caption on a form, spent before the reader has been asked anything. What it was really for is
 * behind the mark, at the length it needs, for whoever wants it.
 */
function Part({
  title,
  help,
  children,
}: {
  title: string;
  /** The paragraphs behind the mark, built only when the mark is pressed. */
  help: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();

  return (
    <fieldset className={panel.part}>
      <legend>
        <span className={panel.partHead}>
          {title}
          <InfoMark label={title} open={open} controls={id} onToggle={() => setOpen(!open)} />
        </span>
      </legend>

      {open && <InfoBody id={id}>{help}</InfoBody>}

      {children}
    </fieldset>
  );
}

/**
 * The mark that opens a picker, on the label of the field the picker fills in.
 *
 * Drawn as the help mark is drawn, because it is the same kind of offer standing in the same
 * place: press this and you will be shown something. What it shows differs — one is a paragraph,
 * one is the broker — and the glyph is what says which.
 */
function PickMark({
  label,
  open,
  onToggle,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const words = open ? `Hide ${label}` : `Show ${label}`;

  return (
    <button
      type="button"
      className={styles.pickMark}
      aria-expanded={open}
      aria-label={words}
      title={words}
      onClick={onToggle}
    >
      {children}
    </button>
  );
}

/* ---- what is behind the four marks ----

   Written as components rather than as constants so none of it is built until a mark is pressed,
   and kept at the foot of the file rather than beside the fields: this is the prose that used to
   be in the form, and the whole point of the change is that the form is now readable without it.

   The voice is the console's own — say the thing, say why, and say what happens when it is left
   off, which is the question a form can never answer by having a box for it. */

function WatchesHelp() {
  return (
    <>
      <p>
        <b>Name</b> is what the alarm is called in the panel, in the corner and in the log. It is
        for whoever reads it at three in the morning, so name the plant and not the rule.
      </p>
      <p>
        <b>Topic filter</b> decides whose messages this rule reads. <code>+</code> stands for one
        level and <code>#</code> for the rest of the tree, so <code>plant/+/temp</code> is every
        room&rsquo;s temperature and <code>plant/#</code> is the whole plant. Press the glass to
        pick one out of what the broker has actually sent.
      </p>
      <p>
        <b>Field</b> narrows it further, to one value inside a JSON body. Leave it empty and the
        rule is about the whole message, which is what a topic publishing a bare{' '}
        <code>23.5</code> sends.
      </p>
      <p>
        <b>Severity</b> decides where a standing alarm sits in the panel and which colour the
        rail&rsquo;s count wears. It changes nothing about when the rule fires.
      </p>
    </>
  );
}

function FiresHelp() {
  return (
    <>
      <p>
        <b>Condition</b> is one test against whatever the Field points at — over a line, inside a
        band, matching an expression, or one of the shapes that watch a run of readings rather
        than a single one.
      </p>
      <p>
        <b>all</b> and <b>any</b> hold other conditions instead of a value of their own:{' '}
        <b>all</b> fires when every one of them is true, <b>any</b> when one of them is. That is
        how &lsquo;hot <i>and</i> the pump is off&rsquo; is written.
      </p>
      <p>
        A message that does not carry the Field at all is neither true nor false — it is skipped.
        A rule reading <code>&lt; 10</code> does not fire because a topic went quiet.
      </p>
      <p>
        Without a clear rule of its own, the alarm stands until its own condition stops being
        true, and then it clears.
      </p>
    </>
  );
}

function ClearHelp() {
  return (
    <>
      <p>
        Off, the alarm clears the moment its own condition stops being true. On, clearing gets a
        condition of its own.
      </p>
      <p>
        What that buys is a reading sitting on the line. Fire above 80 and clear below 70, and a
        boiler wobbling between 79.9 and 80.1 rings once; without the gap it rings, clears and
        rings again on every message.
      </p>
    </>
  );
}

function ElseHelp() {
  return (
    <>
      <p>
        <b>For</b> is how long the condition has to stay true before it counts as an alarm. Empty
        means the moment it is true. It is what stops one stray reading from waking anybody.
      </p>
      <p>
        <b>Cooldown</b> is how long this rule stays quiet after it has fired, whatever the
        readings do. It is counted from the firing, not from the clearing.
      </p>
      <p>
        The rest is who is told: a row in the <b>Alerts panel</b> and on the wall down the side, a{' '}
        <b>sound</b>, a <b>webhook</b> posted to an address of your own, and a <b>publish</b> back
        to the broker so other things on the plant can act on it. <b>Enabled</b> turned off keeps
        the rule and stops the engine reading it.
      </p>
    </>
  );
}

function FieldHelp() {
  return (
    <>
      <p>A path into the message body. For a topic sending this:</p>
      <pre>{'{\n  "temp": 21.5,\n  "pump": { "state": "RUN" },\n  "radios": [{ "crc": 3 }]\n}'}</pre>
      <Example
        rows={[
          ['(empty)', 'the whole body, as it arrived'],
          ['$.temp', '21.5'],
          ['$.pump.state', 'RUN'],
          ['$.radios[0].crc', '3'],
          ['radios.0.crc', 'the same 3, written the other way'],
        ]}
      />
      <p>
        Six levels deep at most. A path that finds nothing is not an error — the message is simply
        skipped — so a rule with a typo in it saves happily and then never fires. Press the braces
        to pick a path out of a real message instead of typing one.
      </p>
    </>
  );
}
