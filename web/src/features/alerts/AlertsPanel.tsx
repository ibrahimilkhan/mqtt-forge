import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { clearAlertHistory, getAlertRules, muteAlert, putAlertRules } from '../../api/alerts';
import { queryKeys } from '../../api/queryKeys';
import { PanelShell } from '../../components/PanelShell';
import { duration } from '../../lib/format';
import { useGuardedMutate } from '../../lib/useGuardedMutate';
import { useNow } from '../../lib/useNow';
import { mutedUntil, useAlertStore } from '../../stores/alertStore';
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
import { openRuleEditor, removeRule, saveRule } from './ruleDraft';
import { SoundButton } from './SoundButton';

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
 * How long a mute lasts unless the reader says otherwise.
 *
 * Fifteen minutes is long enough to finish looking at the thing that is actually wrong and short
 * enough that a mute nobody lifts puts itself right. A mute with no end is how an alarm system
 * stops being one.
 */
const MUTES = [
  { minutes: 15, said: '15 min' },
  { minutes: 60, said: '1 hour' },
  { minutes: 240, said: '4 hours' },
];

/** How often the 'up for' figures are worked out. Once a second: they are read, not watched. */
const BEAT_MS = 1000;

export function AlertsPanel({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const { data, isError } = useQuery({ queryKey: queryKeys.alertRules, queryFn: getAlertRules });

  const active = useAlertStore((state) => state.active);
  const history = useAlertStore((state) => state.history);
  const diagnostics = useAlertStore((state) => state.rules);
  const warming = useAlertStore((state) => state.warming);
  const dropped = useAlertStore((state) => state.dropped);
  const webhooksDropped = useAlertStore((state) => state.webhooksDropped);
  const suppressed = useAlertStore((state) => state.suppressed);
  const capped = useAlertStore((state) => state.capped);
  const blindSeconds = useAlertStore((state) => state.blindSeconds);
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

  // Only while something is standing: a beat that goes on ticking under an empty panel is a
  // re-render a second for a figure nobody is looking at.
  const now = useNow(active.length > 0 ? BEAT_MS : null);

  const mute = useMutation({
    // Three parameters rather than one object, because that is the shape `api/alerts.ts` has and
    // a wrapper here is cheaper than a second spelling of the same call in the API layer.
    mutationFn: ({ ruleId, topic, minutes }: { ruleId: string; topic: string; minutes: number }) =>
      muteAlert(ruleId, topic, minutes),
    // The snapshot is what says a pair is muted, so the console asks for it again rather than
    // guessing at what the server did with the minutes it was given. The hub says the same thing
    // a moment later and the two agree, because both go through the one snapshot.
    onSuccess: () => void load(),
    onError: (error) => logFault('Alert not muted', error),
  });
  // One mute at a time. A mute is one round trip and the guard is what stops a double click
  // sending two — the second press is dropped rather than queued, which is what the reader who
  // pressed it twice meant.
  const guardedMute = useGuardedMutate(mute);

  const forget = useMutation({
    mutationFn: clearAlertHistory,
    onSuccess: () => void load(),
    onError: (error) => logFault('History not cleared', error),
  });
  const guardedForget = useGuardedMutate(forget);

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

  // One path makes a draft and opens the window on it, which is what makes 'prefilled once, at
  // open' a fact about the code rather than a discipline this panel has to keep.
  const edit = (rule?: AlertRuleDto) => openRuleEditor(rule);

  // Loudest first, and within a level the newest — which is the order the reader would put them
  // in themselves if they had to choose what to look at next.
  const standing = [...active].sort(
    (one, other) =>
      RANK[one.severity] - RANK[other.severity] ||
      Date.parse(other.firedAt) - Date.parse(one.firedAt),
  );

  return (
    <PanelShell title="Alerts" onClose={onClose}>
      <h3 className={styles.title}>Alerting now</h3>

      {standing.length === 0 && (
        <p className="empty">Nothing is alarming. A rule that fires shows up here and in the corner.</p>
      )}

      {standing.map((alert) => (
        <AlertRow
          key={alert.id}
          alert={alert}
          now={now}
          onMute={(minutes) =>
            guardedMute({ ruleId: alert.ruleId, topic: alert.topic, minutes })
          }
        />
      ))}

      {history.length > 0 && (
        <>
          <h3 className={styles.title}>Lately</h3>
          {history.map((alert) => (
            <div key={alert.id} className={styles.past} data-testid="alert-past">
              <span className={styles.topic}>{alert.topic}</span>
              <span className={styles.rule}>{alert.ruleName}</span>
              <span className={styles.reason}>
                {alert.resolvedBy
                  ? `out at ${clock(alert.resolvedAt)} — ${alert.resolvedBy}`
                  : `out at ${clock(alert.resolvedAt)}`}
              </span>
            </div>
          ))}
          <div className={panel.actions}>
            <button type="button" className="ghost" onClick={() => guardedForget()}>
              Clear history
            </button>
          </div>
        </>
      )}

      <h3 className={styles.title}>Rules</h3>

      {isError && (
        <p className={panel.fault}>
          The alert rules could not be read. Nothing here has been changed, and saving is off
          until they can be.
        </p>
      )}

      {!isError && rules.length === 0 && (
        <p className="empty">No alert rules yet. Add one and say what should be watched for.</p>
      )}

      {rules.map((rule) => {
        // A rule the server holds always has an id; the null is for a rule being written, which
        // never reaches this list.
        const diagnostic = rule.id === null ? undefined : seen.get(rule.id);

        return (
          <div key={rule.id} className={styles.ruleBlock} data-testid="alert-rule">
            <div className={styles.ruleRow}>
              <input
                type="checkbox"
                checked={rule.enabled}
                aria-label={`Turn ${rule.name} ${rule.enabled ? 'off' : 'on'}`}
                onChange={() =>
                  guardedWrite(
                    saveRule(held().rules, { ...rule, enabled: !rule.enabled }),
                  )
                }
              />
              <span className={styles.ruleName} data-severity={rule.severity}>
                {rule.name}
              </span>
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
            </div>
            <span className={styles.filter}>{rule.filter}</span>
            {/* What the rule can actually see, which is the answer to 'why has this never
                fired'. Without it the only way to tell a rule that is watching nothing from one
                that is watching everything and finding nothing wrong is to go and look at the
                broker. */}
            <span className={styles.seen}>{diagnostic ? sighting(diagnostic) : 'not yet running'}</span>
          </div>
        );
      })}

      <div className={panel.actions}>
        <button type="button" className="ghost" onClick={() => edit()}>
          New rule
        </button>
      </div>

      {warming.length > 0 && (
        <>
          <h3 className={styles.title}>Filling up</h3>
          {warming.map((pair) => (
            <p key={`${pair.ruleId}/${pair.topic}`} className={panel.note}>
              {`${pair.topic} · ${pair.have} of ${pair.need} readings · ${pair.note}`}
            </p>
          ))}
        </>
      )}

      {/* Every one of these is silent until its number moves. A row reading 'dropped 0' on every
          console that has never dropped anything is reassurance nobody asked for, and it teaches
          the eye to skip the place where the bad news will appear. */}
      {dropped > 0 && (
        <p className={panel.fault} data-testid="engine-row">
          {`${dropped} messages went past unjudged — the engine was behind.`}
        </p>
      )}
      {webhooksDropped > 0 && (
        <p className={panel.fault} data-testid="engine-row">
          {`${webhooksDropped} webhook calls were dropped — more were owed than could be sent.`}
        </p>
      )}
      {suppressed > 0 && (
        <p className={panel.note} data-testid="engine-row">
          {`${suppressed} firings were swallowed by a cooldown or a mute.`}
        </p>
      )}
      {/* A list, not a count: the engine names each rule that hit its ceiling and says how many
          topics it stopped tracking. The topics are the part a reader can act on — a ceiling
          reached is a rule whose filter is wider than anybody meant it to be. */}
      {capped.length > 0 && (
        <p className={panel.fault} data-testid="engine-row">
          {`${capped.length} rule${capped.length === 1 ? '' : 's'} reached a ceiling and stopped ` +
            `counting — ${capped.reduce((sum, one) => sum + one.untracked, 0)} topics untracked.`}
        </p>
      )}
      {blindSeconds > 0 && (
        <p className={panel.fault} data-testid="engine-row">
          {`Blind: nothing has been judged for ${duration(blindSeconds * 1000)}.`}
        </p>
      )}
      {faulted.map((one) => (
        <p key={one.ruleId} className={panel.fault} data-testid="engine-row">
          {`${nameOf(rules, one.ruleId)} has faulted: ${one.faultReason ?? 'no reason given'}.`}
        </p>
      ))}

      {/* Task 7's button, on the panel it was drawn for. The preference, the audio context and
          the three things the button can say all live in that task; what is decided here is only
          that alerting's one sound control stands with alerting's other controls, at the foot of
          the panel, rather than among the type sizes in Settings. */}
      <div className={panel.actions}>
        <SoundButton />
      </div>
    </PanelShell>
  );
}

/** One alarm that is on now. */
function AlertRow({
  alert,
  now,
  onMute,
}: {
  alert: AlertDto;
  now: number;
  onMute: (minutes: number) => void;
}) {
  const [minutes, setMinutes] = useState(MUTES[0].minutes);
  // The pair list, not the alert's own stamp. The two say the same thing while the alert is the
  // one the mute was set on — but a mute outlives its alarm, so an alarm that cleared and rang
  // again carries no stamp while the pair is still quiet. The hub's alertMuted writes the pair;
  // only a fresh snapshot rewrites the stamp, and the row must not wait for one.
  const held = useAlertStore((state) => mutedUntil(state, alert.ruleId, alert.topic, now));
  const muted = held !== undefined;

  return (
    <div className={styles.alert} data-testid="alert-row" data-muted={muted ? '' : undefined}>
      <div className={styles.alertHead}>
        {/* The level in words as well as in colour. A reader who cannot tell this red from this
            amber is exactly the reader who most needs to know which one it is. */}
        <span className={styles.level} data-severity={alert.severity}>
          {alert.severity}
        </span>
        <span className={styles.topic}>{alert.topic}</span>
      </div>

      <span className={styles.rule}>{alert.ruleName}</span>
      <span className={styles.reason}>{alert.reason}</span>
      <span className={styles.since}>{`up ${duration(Math.max(0, now - Date.parse(alert.firedAt)))}`}</span>

      {/* What was done about it, and what could not be. A channel that failed says so where the
          alarm is, not only in the log: an alarm nobody was told about is the failure this whole
          feature exists to avoid. The server writes a failure as 'webhook: 404' and a delivery
          as the bare channel name, so the colon is what tells them apart. */}
      {alert.actions.length > 0 && (
        <div className={styles.marks}>
          {alert.actions.map((mark, index) => (
            <span
              key={`${mark}-${index}`}
              className={styles.mark}
              data-failed={mark.includes(':') ? '' : undefined}
            >
              {mark}
            </span>
          ))}
        </div>
      )}

      {muted ? (
        <div className={styles.muteRow}>
          <span className={styles.reason}>{`muted until ${clock(held)}`}</span>
          <button
            type="button"
            className={styles.quiet}
            aria-label={`Lift the mute on ${alert.topic}`}
            // Nought lifts it, which is the API's own way of saying so.
            onClick={() => onMute(0)}
          >
            Lift
          </button>
        </div>
      ) : (
        <div className={styles.muteRow}>
          <select
            className={styles.minutes}
            value={minutes}
            aria-label={`How long to mute ${alert.topic}`}
            onChange={(event) => setMinutes(Number(event.target.value))}
          >
            {MUTES.map((choice) => (
              <option key={choice.minutes} value={choice.minutes}>
                {choice.said}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={styles.quiet}
            aria-label={`Mute alerts on ${alert.topic}`}
            onClick={() => onMute(minutes)}
          >
            Mute
          </button>
        </div>
      )}
    </div>
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
const clock = (at: string | null) =>
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
