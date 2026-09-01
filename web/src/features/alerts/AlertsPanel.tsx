import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { getAlertRules, putAlertRules } from '../../api/alerts';
import { queryKeys } from '../../api/queryKeys';
import { PanelShell } from '../../components/PanelShell';
import { Plus } from '../brand/icons';
import { useGuardedMutate } from '../../lib/useGuardedMutate';
import { useAlertStore } from '../../stores/alertStore';
import { logFault, useLogStore } from '../../stores/logStore';
import panel from '../../styles/panel.module.css';
import type {
  AlertDto,
  AlertRuleDto,
  AlertRulesResponseDto,
  AlertSeverity,
  RuleDiagnosticDto,
} from '../../types/api';
import styles from './AlertsPanel.module.css';
import { RuleEditor } from './RuleEditor';
import { forgetDraft, readDraft, removeRule, sameDraft, saveRule, startRuleDraft } from './ruleDraft';
import { firesOn } from './ruleSummary';
import type { DraftRule } from './ruleDraft';

/**
 * Which of three levels is the loudest, said as a number so it can be sorted on.
 *
 * Exported because the rail badge needs the same order and there must not be two answers to
 * 'which of these is the worst' in one console.
 */
export const RANK: Record<AlertSeverity, number> = { critical: 0, warn: 1, info: 2 };

/** The loudest level standing, or nothing at all. */
export function worst(alerts: readonly AlertDto[]): AlertSeverity | null {
  let found: AlertSeverity | null = null;

  for (const alert of alerts) {
    if (found === null || RANK[alert.severity] < RANK[found]) found = alert.severity;
  }

  return found;
}

export function AlertsPanel({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const { data, isError } = useQuery({ queryKey: queryKeys.alertRules, queryFn: getAlertRules });

  const diagnostics = useAlertStore((state) => state.rules);
  const warming = useAlertStore((state) => state.warming);
  const dropped = useAlertStore((state) => state.dropped);
  const webhooksDropped = useAlertStore((state) => state.webhooksDropped);
  const suppressed = useAlertStore((state) => state.suppressed);
  const capped = useAlertStore((state) => state.capped);
  const load = useAlertStore((state) => state.load);

  /**
   * Read once when the panel opens.
   *
   * The bridge already loads on connect, and this is the second chance rather than a duplicate:
   * a console whose first load failed, or that was opened before the hub came up, would
   * otherwise show an empty panel that never corrects itself and looks exactly like a quiet
   * broker. `load()` replaces rather than merges, so a second call costs one request and settles
   * nothing else.
   */
  useEffect(() => {
    void load();
  }, [load]);

  const write = useMutation({
    mutationFn: (rules: AlertRuleDto[]) => putAlertRules(rules, false),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.alertRules });

      // The server takes the list and tells us which rules it could not keep whole. Silence
      // about that is how a rule quietly stops being the rule somebody wrote.
      if (result.warnings.length > 0) {
        useLogStore.getState().push({
          kind: 'fault',
          verb: 'Alert rules changed on the way in',
          body: result.warnings.map((warning) => `${warning.ruleId}: ${warning.reason}`).join(' · '),
        });
      }
    },
    onError: (error) => logFault('Alert rules not saved', error),
  });
  const guardedWrite = useGuardedMutate(write);

  const rules = data?.rules ?? [];
  const seen = new Map(diagnostics.map((one) => [one.ruleId, one]));
  const faulted = diagnostics.filter((one) => one.faulted);

  // Whether the Engine group has a single line to draw. Worked out here rather than as five
  // conditions inside the heading, because the heading is the thing that must not appear over an
  // empty section — a section title with nothing under it is a reader looking for what is missing.
  const engineHasSomethingToSay =
    dropped > 0 ||
    webhooksDropped > 0 ||
    suppressed > 0 ||
    capped.length > 0 ||
    faulted.length > 0 ||
    warming.length > 0;

  /**
   * The rule list as the cache holds it AT THE MOMENT OF THE CLICK.
   *
   * Three writers edit this list — this switch, this × and any number of editor windows — and a
   * body compiled from anything older would undo whichever of them clicked first. The fallback
   * is for the one render where the query has not answered yet: sending an empty list there
   * would be a save, so nothing in this panel is clickable before the rules arrive anyway.
   */
  const held = () =>
    queryClient.getQueryData<AlertRulesResponseDto>(queryKeys.alertRules) ?? {
      rules: [] as AlertRuleDto[],
    };

  /**
   * The rule being written, and the draft as it stood when the editor opened.
   *
   * The editor used to be a window of its own, floating over the console. It is here now, in place
   * of the list: writing a rule is the panel's whole job while it is happening, and a form that
   * covers the list it came from cannot be lost behind the thing it is about.
   *
   * The opening copy is kept beside the id so that leaving can tell a draft somebody typed into
   * from one they only looked at. Read once, at open — `readDraft` hands back the live object the
   * editor mutates through `keepDraft`, so a reference held here would change under us and every
   * draft would look untouched.
   */
  const [editing, setEditing] = useState<{ draftId: string; opened: DraftRule } | null>(null);

  /** Whether the reader is being asked to confirm they meant to leave. */
  const [leaving, setLeaving] = useState(false);

  // One path makes a draft and shows the editor on it, which is what makes 'prefilled once, at
  // open' a fact about the code rather than a discipline this panel has to keep.
  const edit = (rule?: AlertRuleDto) => {
    const draftId = startRuleDraft(rule);

    setEditing({ draftId, opened: structuredClone(readDraft(draftId)!) });
    setLeaving(false);
  };

  /** Back to the list, and the draft goes with it: leaving is abandoning. */
  const leave = () => {
    if (editing) forgetDraft(editing.draftId);
    setEditing(null);
    setLeaving(false);
  };

  /**
   * Back, or the confirmation first.
   *
   * A draft nobody has typed into is nothing to lose, so leaving one is silent. A draft that has
   * been filled in is minutes of somebody's work, and this is the only thing standing between it
   * and a mis-aimed click on Back.
   */
  const back = () => {
    if (editing && !sameDraft(readDraft(editing.draftId) ?? editing.opened, editing.opened)) {
      setLeaving(true);

      return;
    }

    leave();
  };

  // Escape is the console's one rule about Escape — it shuts the thing in front of you — and the
  // editor is what is in front. Through `back`, so it cannot throw work away either.
  useEffect(() => {
    if (editing === null) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') back();
    };

    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  });

  // The editor takes the panel while it is open. The list is not merely hidden behind it: a rule
  // being written is what the panel is for until it is saved or given up, and half a list showing
  // under a form is an invitation to click something that will be gone in a moment.
  if (editing !== null) {
    return (
      <PanelShell title="Alerts" onClose={onClose}>
        {/* Back is inside the editor now, on the row Save is on: it is the other answer to the
            question that row asks, not a way of navigating away from the panel. What is left here
            is the question it can raise, and that has to be BELOW the editor — it is about a
            press the reader has just made on the form's last row, and an answer that appeared
            above the first column would be an answer somewhere else on the screen. */}
        <RuleEditor draftId={editing.draftId} onDone={leave} onBack={back} />

        {/* Not a browser confirm(): that is a dialog from somewhere else, wearing somebody else's
            type, and it stops the console dead while it is up. This is a line in the panel with
            the two answers beside it, and the form stays on screen above — which is the thing the
            reader is being asked about. */}
        {leaving && (
          <div className={panel.fault} role="alertdialog" aria-label="Leave without saving?">
            <p>This rule has been filled in and not saved. Leave it?</p>
            {/* Side by side, and NOT with `panel.trailing` on the second: that holds a form's
                acting button against the right-hand end of a row, which is right for a row whose
                other end is the form. This row is one question, and the panel is now as wide as
                the workspace — its two answers thrown to opposite edges of 1400px would be two
                buttons that do not look like they are about the same thing. */}
            <div className={panel.actions}>
              <button type="button" className="ghost" onClick={() => setLeaving(false)}>
                Keep writing
              </button>
              <button type="button" onClick={leave}>
                Discard it
              </button>
            </div>
          </div>
        )}
      </PanelShell>
    );
  }

  return (
    <PanelShell title="Alerts" onClose={onClose}>
      {/* 'Alerting now' stood here, above the rules: every standing alarm, how long it had been
          up, and the control that muted the pair it was about. The panel is what is being watched
          FOR now, and nothing about what is wrong — those are two different questions, and this
          one is the only place the first is answered.

          What is alarming is the count on the rail. Muting went out with the row it was performed
          on, because that row was the only way to reach it; the mute endpoint, the store's muted
          list and the hub's alertMuted are all untouched and all still tested. */}

      {/* 'Lately' stood here: every alarm that had gone out, with what put it out, and a button to
          clear the lot. It answered a question nobody opens this panel with — the two that bring a
          reader here are 'what is wrong now' and 'what am I watching for', and a growing list of
          things that are no longer wrong sat between the two of them. The store still holds the
          history, and the server still keeps it; the panel simply does not draw it. */}

      {/* The heading and the one thing you can do to the list, on one line.
 
          'New rule' used to stand under the table in a row of its own, which is where a form's
          Save goes — the end of a thing being filled in. This list is not being filled in. The
          button makes a new one, and the place a reader looks for 'make one more of these' is the
          end of the line the section is named on. On an empty panel it also stops being a control
          stranded under a sentence about there being nothing here. */}
      <div className={panel.sectionTop}>
        <h3 className={panel.sectionTitle}>Rules</h3>

        <button
          type="button"
          className={`ghost ${panel.iconButton}`}
          onClick={() => edit()}
        >
          <Plus />
          New rule
        </button>
      </div>

      {isError && (
        <p className={panel.fault}>
          The alert rules could not be read. Nothing here has been changed, and saving is off
          until they can be.
        </p>
      )}

      {!isError && rules.length === 0 && (
        // Not the app's usual `.empty`, which is a line ruled off at the left and belongs beside
        // something — a pane that has not filled in yet, a tree with no broker. This one has the
        // whole workspace to itself, and a sentence pinned to the left edge of a 1400px panel
        // reads as a caption on nothing. Centred, it is the panel saying what it is for.
        <div className={panel.nothingYet}>
          {/* The sentence is a child of the centring box rather than being it. A flex container
              makes each of its inline children an item and drops the whitespace-only text nodes
              between them, so 'Press New rule and' came out with the spaces around the bold words
              closed up. One item, laid out as text inside it. */}
          <p>No alert rules yet. Press <b>New rule</b> and say what should be watched for.</p>
        </div>
      )}

      {/* The header exists for the four columns that were not on screen at all before it: a
          reader who has never seen this table needs to be told that the mono line in the middle
          is what fires the rule and the chips beside it are what it does about it. */}
      {!isError && rules.length > 0 && (
        <div className={styles.rules}>
          <div className={`${styles.rulesHead} ${panel.rulesHead}`} aria-hidden="true">
            <span>#</span>
            <span>On</span>
            <span>Rule</span>
            <span>Level</span>
            <span>Fires on</span>
            <span>Does</span>
            <span>Seeing</span>
            <span />
          </div>

          {rules.map((rule, at) => {
            // A rule the server holds always has an id; the null is for a rule being written,
            // which never reaches this list.
            const diagnostic = rule.id === null ? undefined : seen.get(rule.id);

            return (
              <div
                key={rule.id}
                className={styles.ruleRow}
                data-testid="alert-rule"
                data-severity={rule.severity}
                data-off={rule.enabled ? undefined : ''}
              >
                {/* Its place in the list, so a rule can be pointed at in a sentence somebody says
                    out loud. The order is the file's — the order they were written in — and not
                    the name's: a list that reorders itself when a rule is renamed is a list whose
                    numbers mean nothing twice running. */}
                <span className={panel.ruleNumber} data-testid="rule-number">
                  {at + 1}
                </span>

                <input
                  type="checkbox"
                  checked={rule.enabled}
                  aria-label={`Turn ${rule.name} ${rule.enabled ? 'off' : 'on'}`}
                  onChange={() =>
                    guardedWrite(saveRule(held().rules, { ...rule, enabled: !rule.enabled }))
                  }
                />

                <span className={styles.cellRule}>
                  <span className={styles.ruleName}>{rule.name}</span>
                  <span className={styles.filter}>{rule.filter}</span>
                </span>

                <span className={styles.level} data-severity={rule.severity}>
                  {rule.severity}
                </span>

                <span className={styles.fires}>{firesOn(rule)}</span>

                {/* The same chips an alarm wears when it fires, so the row and the alarm it
                    produces are plainly about the same channels. */}
                <span className={styles.marks}>
                  {rule.actions.map((action) => (
                    <span key={action.type} className={styles.mark}>
                      {action.type}
                    </span>
                  ))}
                </span>

                {/* What the rule can actually see, which is the answer to 'why has this never
                    fired'. Without it the only way to tell a rule that is watching nothing from
                    one that is watching everything and finding nothing wrong is to go and look at
                    the broker. */}
                <span className={styles.seen}>
                  {diagnostic ? sighting(diagnostic) : 'not yet running'}
                </span>

                <span className={styles.rowActions}>
                  <button
                    type="button"
                    className={styles.quiet}
                    aria-label={`Edit ${rule.name}`}
                    onClick={() => edit(rule)}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className={styles.remove}
                    aria-label={`Remove ${rule.name}`}
                    onClick={() => guardedWrite(removeRule(held().rules, rule.id ?? ''))}
                  >
                    ×
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* ---- what the engine is doing ----

          Five kinds of line used to stand loose at the foot of the panel: three reds, a note, and
          a 'Filling up' heading with its own list under it. Loose, they read as five unrelated
          complaints; together they are one answer to one question, which is whether the engine is
          keeping up with what it was asked to do.

          Every line is silent until it has something to say. A row reading 'dropped 0' on a
          console that has never dropped anything is reassurance nobody asked for, and it teaches
          the eye to skip the place the bad news will appear. */}
      {engineHasSomethingToSay && (
        <section className={styles.engine} aria-label="What the engine is doing">
          <h3 className={panel.sectionTitle}>Engine</h3>

          {dropped > 0 && (
            <p className={styles.engineRow} data-severity="critical" data-testid="engine-row">
              {`${dropped} messages went past unjudged — the engine was behind.`}
            </p>
          )}
          {webhooksDropped > 0 && (
            <p className={styles.engineRow} data-severity="critical" data-testid="engine-row">
              {`${webhooksDropped} webhook calls were dropped — more were owed than could be sent.`}
            </p>
          )}
          {/* A list, not a count: the engine names each rule that hit its ceiling and says how
              many topics it stopped tracking. The topics are the part a reader can act on — a
              ceiling reached is a rule whose filter is wider than anybody meant it to be. */}
          {capped.length > 0 && (
            <p className={styles.engineRow} data-severity="critical" data-testid="engine-row">
              {`${capped.length} rule${capped.length === 1 ? '' : 's'} reached a ceiling and ` +
                `stopped counting — ${capped.reduce((sum, one) => sum + one.untracked, 0)} topics untracked.`}
            </p>
          )}
          {faulted.map((one) => (
            <p
              key={one.ruleId}
              className={styles.engineRow}
              data-severity="critical"
              data-testid="engine-row"
            >
              {`${nameOf(rules, one.ruleId)} has faulted: ${one.faultReason ?? 'no reason given'}.`}
            </p>
          ))}
          {suppressed > 0 && (
            <p className={styles.engineRow} data-testid="engine-row">
              {`${suppressed} firings were swallowed by a cooldown or a mute.`}
            </p>
          )}
          {/* Filling up had a heading of its own. It is the same question — is the engine ready to
              judge anything — and a pair still counting toward its window is the most ordinary
              reason a rule has never fired. */}
          {warming.map((pair) => (
            <p key={`${pair.ruleId}/${pair.topic}`} className={styles.engineRow} data-testid="engine-row">
              {`${pair.topic} · ${pair.have} of ${pair.need} readings · ${pair.note}`}
            </p>
          ))}
        </section>
      )}

    </PanelShell>
  );
}

/**
 * What a rule has seen, in one line.
 *
 * Three sentences, and the order they are asked in matters. 'Matched no topic' comes first
 * because a rule watching nothing has no readings to report and the counts would say '0
 * readings' as though the broker were quiet. 'No message could be read' is guarded on there
 * having been something to read at all: a rule that has seen nothing yet has evaluated 0 and
 * skipped 0, which are equal, and reading that as unreadable would accuse a broker that has
 * simply not sent anything.
 */
function sighting(rule: RuleDiagnosticDto): string {
  if (rule.topics === 0) return 'matched no topic';
  if (rule.evaluated > 0 && rule.evaluated === rule.skipped) return 'no message could be read';

  const fired = rule.lastFiredAt ? `last fired ${clock(rule.lastFiredAt)}` : 'never fired';

  return `${rule.topics} topic${rule.topics === 1 ? '' : 's'} · ${count(rule.evaluated)} reading${
    rule.evaluated === 1 ? '' : 's'
  } · ${fired}`;
}

/** The rule's name if the console still holds it, and its id if the engine is ahead of us. */
const nameOf = (rules: readonly AlertRuleDto[], id: string) =>
  rules.find((rule) => rule.id === id)?.name ?? id;

/** A clock time, hours and minutes. Nobody reads seconds off a line about the last hour. */
export const clock = (at: string | null) =>
  at === null
    ? '—'
    : new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });

/**
 * Thousands as k, millions as M.
 *
 * The same rule the health line counts by, written out again rather than shared: that one is a
 * private helper inside a line with its own reasons, and a reading count in a sentence is not
 * the same job as a cell measured in `ch`.
 */
function count(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;

  return `${(n / 1_000_000).toFixed(1)}M`;
}
