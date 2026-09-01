import { useState } from 'react';
import { Field } from '../../components/Field';
import { QosSelect } from '../../components/QosSelect';
import { Segmented } from '../../components/Segmented';
import panel from '../../styles/panel.module.css';
import type { AlertSeverity } from '../../types/api';
import {
  blankCondition,
  conditionText,
  CONDITION_LABELS,
  CONDITION_TYPES,
  draftOf,
  keepDraft,
  readDraft,
  type ConditionType,
  type DraftRule,
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

  return (
    <form className={panel.form} onSubmit={(event) => event.preventDefault()}>
      <div className={panel.row}>
        <Field label="Name" htmlFor={id('name')}>
          <input
            id={id('name')}
            value={draft.name}
            maxLength={80}
            placeholder="Boiler temperature"
            onChange={(event) => edit({ name: event.target.value })}
          />
        </Field>

        <Field label="Topic filter" htmlFor={id('filter')}>
          <input
            id={id('filter')}
            value={draft.filter}
            spellCheck={false}
            placeholder="plant/+/temp"
            onChange={(event) => edit({ filter: event.target.value })}
          />
        </Field>
      </div>

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
            onChange={(event) => edit({ for: event.target.value })}
          />
        </Field>

        <Field label="Cooldown, seconds" htmlFor={id('cooldown')} narrow>
          <input
            id={id('cooldown')}
            value={draft.cooldown}
            inputMode="numeric"
            placeholder="1"
            onChange={(event) => edit({ cooldown: event.target.value })}
          />
        </Field>
      </div>

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

      {/* What the condition says, as the file says it. Task 6 puts the fields above this; it stays
          for the one case that has no fields — a condition from a newer build, or a tree deeper
          than this form draws — because a reader who opened a rule they did not write is owed the
          chance to see what it holds. */}
      <pre className={panel.note} data-testid="condition-source">
        {conditionText(draft.condition)}
      </pre>

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
          <pre className={panel.note} data-testid="clear-source">
            {conditionText(draft.clear)}
          </pre>
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
        <Field label="Webhook address" htmlFor={id('url')}>
          <input
            id={id('url')}
            value={draft.webhook.url}
            spellCheck={false}
            placeholder="https://ops.example/hook"
            onChange={(event) => edit({ webhook: { ...draft.webhook!, url: event.target.value } })}
          />
        </Field>
      )}

      {draft.publish && (
        <>
          <Field label="Publish topic" htmlFor={id('topic')}>
            <input
              id={id('topic')}
              value={draft.publish.topic}
              spellCheck={false}
              placeholder="the server's own tree"
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
        </>
      )}

      <div className={panel.actions}>
        {/* Closing loses nothing: the draft is in the map, and reopening this rule brings it back
            exactly as it stands. Said here rather than left to be discovered. */}
        <button type="button" className="ghost" onClick={onDone}>
          Close
        </button>
      </div>
    </form>
  );
}
