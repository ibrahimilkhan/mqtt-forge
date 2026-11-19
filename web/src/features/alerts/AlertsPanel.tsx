import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { getAlertRules, putAlertRules } from '../../api/alerts';
import { queryKeys } from '../../api/queryKeys';
import { PanelShell } from '../../components/PanelShell';
import { Plus } from '../brand/icons';
import { useGuardedMutate } from '../../lib/useGuardedMutate';
import { useAlertStore } from '../../stores/alertStore';
import { logFault, useLogStore } from '../../stores/logStore';
import { describeError } from '../../lib/problemDetails';
import panel from '../../styles/panel.module.css';
import type {
  AlertDto,
  AlertRuleDto,
  AlertSeverity,
  RuleDiagnosticDto,
} from '../../types/api';
import styles from './AlertsPanel.module.css';
import { RuleEditor } from './RuleEditor';
import { RuleLibrary } from './RuleLibrary';
import {
  forgetDraft,
  readDraft,
  removeRule,
  sameDraft,
  saveRule,
  startDraftFrom,
  startRuleDraft,
} from './ruleDraft';
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

/**
 * How often the engine's own report is read again while the panel is open.
 *
 * Three seconds: long enough that a panel left open is not a poll every frame, short enough that
 * a reader publishing a test message to see whether a rule matches it does not conclude the
 * panel is dead. Nothing here is watched — the alarms themselves arrive on the hub.
 */
const EVERY_MS = 3000;

export function AlertsPanel({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const { data, isError } = useQuery({ queryKey: queryKeys.alertRules, queryFn: getAlertRules });

  const diagnostics = useAlertStore((state) => state.rules);
  const active = useAlertStore((state) => state.active);
  const warming = useAlertStore((state) => state.warming);
  const dropped = useAlertStore((state) => state.dropped);
  const blindSeconds = useAlertStore((state) => state.blindSeconds);
  const webhooksDropped = useAlertStore((state) => state.webhooksDropped);
  const suppressed = useAlertStore((state) => state.suppressed);
  const capped = useAlertStore((state) => state.capped);
  const load = useAlertStore((state) => state.load);

  /**
   * Read when the panel opens, and again while somebody is looking at it.
   *
   * The bridge already loads on connect, and the read on open is the second chance rather than a
   * duplicate: a console whose first load failed, or that was opened before the hub came up,
   * would otherwise show an empty panel that never corrects itself and looks exactly like a
   * quiet broker. `load()` replaces rather than merges, so a second call costs one request and
   * settles nothing else.
   *
   * Reading it again is what the Seeing column needs. The hub sends alarms — raised, resolved,
   * silenced — and nothing else, so what a rule has *seen* only arrives with a whole snapshot:
   * how many topics it matched, how many readings it judged, when it last fired. A reader who
   * opened this panel to find out why a rule was quiet, published a test message and watched the
   * line go on saying 'matched no topic' was reading a sentence written before they started —
   * while the engine, three feet away, had matched the topic and fired on it. Read on a tick
   * like the Manage panel's counts, which answer the same kind of question.
   */
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), EVERY_MS);

    return () => clearInterval(timer);
  }, [load]);

  /**
   * Every write is a whole rule set, so every write is built on the newest one there is.
   *
   * It used to be built on the query cache, and the cache is only ever as new as this console's
   * last look. Two consoles is the ordinary arrangement — the QR panel exists to put a second one
   * on a phone — and a switch flicked here half a minute after the phone saved a rule sent a list
   * with that rule missing, which is a PUT that deletes it. Nobody edited anything; somebody
   * turned a rule off, and another rule stopped existing.
   *
   * So the change is a function over the list rather than a list, and the list is fetched at the
   * moment of the write. Two people editing the same rule is still last-write-wins, which is what
   * a one-document PUT means and is a race between two people who both meant it. Two people
   * editing different rules is no longer a race at all.
   */
  const write = useMutation({
    mutationFn: async (change: (rules: AlertRuleDto[]) => AlertRuleDto[]) => {
      const fresh = await queryClient.fetchQuery({
        queryKey: queryKeys.alertRules,
        queryFn: getAlertRules,
        staleTime: 0,
      });

      return putAlertRules(change(fresh.rules), false);
    },
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
    blindSeconds > 0 ||
    dropped > 0 ||
    webhooksDropped > 0 ||
    suppressed > 0 ||
    capped.length > 0 ||
    faulted.length > 0 ||
    warming.length > 0;

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

  /**
   * Whether the library of examples is what the panel is showing.
   *
   * It stands where the list stands, like the editor does, and for the same reason: it is the
   * panel's whole job while it is open. It is reached from its own button and never from New
   * rule — a reader who knows what they want is not made to walk past eleven cards to get it.
   */
  const [browsing, setBrowsing] = useState(false);

  /** The editor, on a copy of an example. Leaving it untouched is leaving nothing behind. */
  const editFrom = (draft: DraftRule) => {
    const draftId = startDraftFrom(draft);

    setBrowsing(false);
    setEditing({ draftId, opened: structuredClone(draft) });
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
    if (editing === null && !browsing) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;

      if (editing !== null) back();
      else setBrowsing(false);
    };

    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  });

  // The editor takes the panel while it is open. The list is not merely hidden behind it: a rule
  // being written is what the panel is for until it is saved or given up, and half a list showing
  // under a form is an invitation to click something that will be gone in a moment.
  if (editing !== null) {
    return (
      <PanelShell title="Alerts" named onClose={onClose}>
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
              <button type="button" onClick={() => setLeaving(false)}>
                Keep writing
              </button>
              <button type="button" className="ends" onClick={leave}>
                Discard it
              </button>
            </div>
          </div>
        )}
      </PanelShell>
    );
  }

  if (browsing) {
    return (
      <PanelShell title="Alerts" named onClose={onClose}>
        <RuleLibrary
          onUse={editFrom}
          onBlank={() => {
            setBrowsing(false);
            edit();
          }}
          onBack={() => setBrowsing(false)}
        />
      </PanelShell>
    );
  }

  // How many rules are ringing, for the line the section is named on. Counted in rules rather
  // than in alarms: one rule over a wildcard can hold a dozen alarms and is still one thing to
  // look at in this table.
  const firingRules = new Set(active.map((alert) => alert.ruleId));
  const ringing = rules.filter((rule) => rule.id !== null && firingRules.has(rule.id)).length;

  return (
    <PanelShell title="Alerts" named onClose={onClose}>
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
        <h3 className={panel.sectionTitle}>
          Rules
          {rules.length > 0 && ` · ${rules.length}`}
          {ringing > 0 && (
            <span className={styles.ringing} data-testid="rules-firing">{` · ${ringing} firing`}</span>
          )}
        </h3>

        <div className={styles.ways}>
          <button type="button" onClick={() => setBrowsing(true)}>
            Library
          </button>
          <button
            type="button"
            className={panel.iconButton}
            onClick={() => edit()}
          >
            <Plus />
            New rule
          </button>
        </div>
      </div>

      {isError && (
        <p className={panel.fault}>
          The alert rules could not be read. Nothing here has been changed, and saving is off
          until they can be.
        </p>
      )}

      {/* A change that did not take. Every switch and every × here writes the whole list, and a
          write that fails leaves the rows exactly as they were — a switch flicked and flicked
          back, with the reason a panel away in the broker's record. */}
      {write.isError && (
        <p className={panel.fault} data-testid="write-fault">
          Not saved. {describeError(write.error)}
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
          <p>No rules yet. Create one with <b>New rule</b> or start from the <b>Library</b>.</p>
        </div>
      )}

      {/* The header exists for the four columns that were not on screen at all before it: a
          reader who has never seen this table needs to be told that the mono line in the middle
          is what fires the rule and the chips beside it are what it does about it. */}
      {!isError && rules.length > 0 && (
        <div className={styles.rules}>
          <div className={`${styles.rulesHead} ${panel.rulesHead}`} aria-hidden="true">
            <span>On</span>
            <span>Rule</span>
            <span>Level</span>
            <span>Condition</span>
            <span>State</span>
            <span />
          </div>

          {rules.map((rule) => {
            // A rule the server holds always has an id; the null is for a rule being written,
            // which never reaches this list.
            const diagnostic = rule.id === null ? undefined : seen.get(rule.id);
            const state = standing(
              rule,
              diagnostic,
              active.filter((alert) => alert.ruleId === rule.id),
            );

            return (
              <div
                key={rule.id}
                className={styles.ruleRow}
                data-testid="alert-rule"
                data-severity={rule.severity}
                data-off={rule.enabled ? undefined : ''}
                data-firing={state.tone === 'firing' ? '' : undefined}
              >
                <input
                  type="checkbox"
                  checked={rule.enabled}
                  aria-label={`Turn ${rule.name} ${rule.enabled ? 'off' : 'on'}`}
                  onChange={() =>
                    guardedWrite((rules) => saveRule(rules, { ...rule, enabled: !rule.enabled }))
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

                {/* One short answer to 'what is this rule doing right now'. The counts that used
                    to stand here — topics, readings — answered a question nobody asks of a table;
                    the three states that need acting on (matched nothing, could read nothing,
                    faulted) are still said, in words, in the same place. */}
                <span className={styles.state} data-tone={state.tone} data-testid="rule-state">
                  {state.says}
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
                    onClick={() => guardedWrite((rules) => removeRule(rules, rule.id ?? ''))}
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

          {/* First, because it is the one that makes every rule below untrue: with no link there
              is no traffic, so nothing is being judged and the ticks and counts on the rules are
              about a watch that stopped. The rail says there is no link; it does not say what
              that costs the rules, and this panel is where a reader asks that. */}
          {blindSeconds > 0 && (
            <p className={styles.engineRow} data-severity="warn" data-testid="engine-row">
              {`No broker link — nothing judged for ${blindFor(blindSeconds)}.`}
            </p>
          )}
          {dropped > 0 && (
            <p className={styles.engineRow} data-severity="critical" data-testid="engine-row">
              {`${dropped} ${dropped === 1 ? 'message' : 'messages'} went past unjudged — the engine was behind.`}
            </p>
          )}
          {webhooksDropped > 0 && (
            <p className={styles.engineRow} data-severity="critical" data-testid="engine-row">
              {`${webhooksDropped} webhook ${webhooksDropped === 1 ? 'call was' : 'calls were'} dropped — more were owed than could be sent.`}
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
 * What a rule is doing right now, in a few words.
 *
 * The order is the order of what a reader most needs to be told. Off first, because nothing else
 * is true of a rule that is not being read. Firing next, because it is the reason the panel was
 * opened. Then the three ways a rule can be on and useless — the engine gave up on it, it watches
 * nothing, or it can read nothing it watches — and only then the ordinary case.
 *
 * 'No readable message' is guarded on there having been something to read at all: a rule that has
 * seen nothing yet has evaluated 0 and skipped 0, which are equal, and reading that as unreadable
 * would accuse a broker that has simply not sent anything.
 */
export function standing(
  rule: AlertRuleDto,
  diagnostic: RuleDiagnosticDto | undefined,
  firing: readonly AlertDto[],
): { says: string; tone: 'firing' | 'fault' | 'quiet' | 'plain' } {
  if (!rule.enabled) return { says: 'Disabled', tone: 'quiet' };

  if (firing.length > 0) {
    // The oldest alarm standing: 'since' is when the rule started ringing, not when its
    // latest topic joined in.
    const since = firing.reduce((first, alert) =>
      Date.parse(alert.firedAt) < Date.parse(first.firedAt) ? alert : first,
    );

    return { says: `Firing · ${clock(since.firedAt)}`, tone: 'firing' };
  }

  if (!diagnostic) return { says: 'Not running', tone: 'quiet' };
  if (diagnostic.faulted) return { says: 'Faulted', tone: 'fault' };
  if (diagnostic.topics === 0) return { says: 'No matching topic', tone: 'plain' };
  if (diagnostic.evaluated > 0 && diagnostic.evaluated === diagnostic.skipped) {
    return { says: 'No readable message', tone: 'plain' };
  }

  return {
    says: diagnostic.lastFiredAt
      ? `Active · last ${clock(diagnostic.lastFiredAt)}`
      : 'Active · never fired',
    tone: 'quiet',
  };
}

/** The rule's name if the console still holds it, and its id if the engine is ahead of us. */
const nameOf = (rules: readonly AlertRuleDto[], id: string) =>
  rules.find((rule) => rule.id === id)?.name ?? id;

/** A clock time, hours and minutes. Nobody reads seconds off a line about the last hour. */
export const clock = (at: string | null) =>
  at === null
    ? '—'
    : new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });

/** How long the engine has been blind, in the roundest words that are still true. */
function blindFor(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  return `${Math.round(minutes / 60)}h`;
}
