import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { getAlertRules, putAlertRules } from '../../api/alerts';
import { queryKeys } from '../../api/queryKeys';
import { Field } from '../../components/Field';
import { QosSelect } from '../../components/QosSelect';
import { Segmented } from '../../components/Segmented';
import { useGuardedMutate } from '../../lib/useGuardedMutate';
import { logFault, useLogStore } from '../../stores/logStore';
import panel from '../../styles/panel.module.css';
import type { AlertRuleDto, AlertRulesResponseDto, AlertSeverity } from '../../types/api';
import { ConditionFields } from './ConditionFields';
import {
  blankCondition,
  CONDITION_LABELS,
  CONDITION_TYPES,
  draftOf,
  faultsIn,
  forgetDraft,
  keepDraft,
  readDraft,
  ruleOf,
  savable,
  saveRule,
  type ConditionType,
  type DraftRule,
  type SaveTarget,
} from './ruleDraft';

/**
 * One alert rule, in a window.
 *
 * A window and not a column, because ten condition types with their own parameters, four modifiers
 * and four channels in 320 pixels is one field to a line and a scrolling tunnel to fill it in.
 *
 * The draft lives in `ruleDraft`, and this holds a copy in state only so React redraws. Every
 * change writes through, which is what makes closing the window safe: the typing is in the map,
 * and Escape — the console's one rule about Escape, which is that it shuts the thing in front of
 * you — costs nothing.
 */
export function RuleEditor({ draftId, onDone }: { draftId: string; onDone: () => void }) {
  const queryClient = useQueryClient();
  // Read, not written to. The list has one owner — this cache — and the editor's job at the click
  // is to hand it back the same list with one rule changed. What is wanted from it here is the two
  // facts only the server knows: where it publishes, and whether it posts webhooks at all.
  const { data } = useQuery({ queryKey: queryKeys.alertRules, queryFn: getAlertRules });

  const [draft, setDraft] = useState<DraftRule>(
    // The map is the source. The fallback is unreachable through `openRuleEditor`, which makes the
    // draft before it opens the window, and exists so a window restored from a stale pane draws a
    // blank form rather than throwing inside a render.
    () => readDraft(draftId) ?? draftOf(undefined, undefined),
  );

  const edit = (change: Partial<DraftRule>) =>
    setDraft((current) => keepDraft(draftId, { ...current, ...change }));

  /**
   * A field id of this window's own.
   *
   * Two editors are open at once as soon as somebody compares two rules, and one id on two boxes
   * would point every label in the second window at the first window's field — so a click on a
   * label would move the focus into the wrong window entirely. The draft id carries a colon and a
   * rule id may carry a dash, so it is reduced to what an id is safely made of.
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

  return (
    <form className={panel.form} onSubmit={(event) => event.preventDefault()}>
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

        <Field label="Topic filter" htmlFor={id('filter')}>
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

      {faults.name && <p className={panel.fault}>{faults.name}</p>}
      {faults.filter && <p className={panel.fault}>{faults.filter}</p>}

      <div className={panel.row}>
        <Field label="Field" htmlFor={id('field')}>
          <input
            id={id('field')}
            value={draft.field}
            spellCheck={false}
            placeholder="$.temp"
            onChange={(event) => edit({ field: event.target.value })}
          />
        </Field>

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
        note={
          draft.severity === 'critical'
            ? 'A critical notice stays on screen until it is dismissed.'
            : 'An info or warn notice fades after a few seconds.'
        }
      />

      <Field label="Condition" htmlFor={id('condition')}>
        <select
          id={id('condition')}
          value={draft.condition.type === 'opaque' ? '' : draft.condition.type}
          onChange={(event) =>
            edit({ condition: blankCondition(event.target.value as ConditionType) })
          }
        >
          {/* A condition this form cannot draw is a real state and it needs a place in the picker
              to sit, or the select would silently show whatever option happens to be first and read
              as a rule that says something it does not. */}
          {draft.condition.type === 'opaque' && <option value="">As the file has it</option>}
          {CONDITION_TYPES.map((type) => (
            <option key={type} value={type}>
              {CONDITION_LABELS[type]}
            </option>
          ))}
        </select>
      </Field>

      <ConditionFields
        condition={draft.condition}
        id={(name) => id(`condition-${name}`)}
        onChange={(condition) => edit({ condition })}
      />
      {faults.condition && <p className={panel.fault}>{faults.condition}</p>}

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
            checked={draft.clear !== null}
            onChange={(event) =>
              edit({ clear: event.target.checked ? blankCondition('threshold') : null })
            }
          />
          Clear on a condition of its own
        </label>
      </div>

      {draft.clear && (
        <>
          <Field label="Clear when" htmlFor={id('clear')}>
            <select
              id={id('clear')}
              value={draft.clear.type === 'opaque' ? '' : draft.clear.type}
              onChange={(event) =>
                edit({ clear: blankCondition(event.target.value as ConditionType) })
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

          <ConditionFields
            condition={draft.clear}
            id={(name) => id(`clear-${name}`)}
            onChange={(clear) => edit({ clear })}
          />
          {faults.clear && <p className={panel.fault}>{faults.clear}</p>}
        </>
      )}

      <div className={panel.checks}>
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

      <div className={panel.actions}>
        {/* Closing loses nothing: the draft is in the map, and reopening this rule brings it back
            exactly as it stands. Said here rather than left to be discovered. */}
        <button type="button" className="ghost" onClick={onDone}>
          Close
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
