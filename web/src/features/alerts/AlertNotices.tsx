import { useCallback, useEffect, useRef, useState } from 'react';
import { useAlertStore } from '../../stores/alertStore';
import type { AlertDto, AlertSeverity } from '../../types/api';
import type { PanelId } from '../panels';
import { RANK } from './AlertsPanel';
import styles from './AlertNotices.module.css';

/**
 * How long a notice that is not critical stays.
 *
 * Long enough to read a topic, a rule name and a reason without hurrying; short enough that a
 * quiet console does not end the day with a wall of them. Started when the notice is drawn
 * rather than when the alert fired, so one that waited its turn behind three others gets its
 * own six seconds.
 */
const FADES_AFTER_MS = 6000;

/**
 * How many stand at once.
 *
 * Three is what can be read at a glance in the corner of a screen somebody is working in. The
 * rest are not lost: they are on the rail badge, which is where 'how many' belongs, and in the
 * panel, which is where all of them are.
 */
const AT_ONCE = 3;

/** The level in words. The stack is not a place where colour may be the only signal. */
const SAID: Record<AlertSeverity, string> = {
  info: 'info',
  warn: 'warning',
  critical: 'critical',
};

type Notice = { id: string; alert: AlertDto };

/**
 * What is wrong, in the corner, whatever panel is open.
 *
 * The panel is where alarms are dealt with and it is shut most of the time. This is the console
 * saying something out loud — and the only thing it can say that the reader has not asked to
 * see, so it is held to three at once and to a shape they can dismiss without reading twice.
 */
export function AlertNotices({ open }: { open: (id: PanelId) => void }) {
  const active = useAlertStore((state) => state.active);
  const [notices, setNotices] = useState<ReadonlyArray<Notice>>([]);

  /**
   * The ids that were standing last time this looked.
   *
   * Null until the first snapshot, which is what tells 'the console just opened onto four
   * standing alarms' from 'four alarms just fired'. Only the ids currently active are held, so
   * a console left open for a week does not accumulate a set of every alarm it ever saw.
   */
  const before = useRef<ReadonlySet<string> | null>(null);

  const dismiss = useCallback(
    (id: string) => setNotices((current) => current.filter((notice) => notice.id !== id)),
    [],
  );

  useEffect(() => {
    const standing = new Set(active.map((alert) => alert.id));
    const previous = before.current;
    before.current = standing;

    // The state of the world when the console opened is not news. See rule 4 above.
    if (previous === null) return;

    const fresh = active.filter((alert) => !previous.has(alert.id));

    setNotices((current) => {
      // An alarm that has gone out takes its notice with it, critical included. A notice standing
      // over an alert the engine no longer holds is the phantom alarm wearing a different coat:
      // it cannot be opened, muted or resolved, and the panel it leads to does not have it.
      const kept = current.filter((notice) => standing.has(notice.id));

      if (fresh.length === 0) return kept.length === current.length ? current : kept;

      return [...kept, ...fresh.map((alert) => ({ id: alert.id, alert }))];
    });
  }, [active]);

  // Loudest first, then newest. Ordered rather than simply capped, so a critical is never the
  // one pushed out of view by two warnings that happened to arrive after it.
  const shown = [...notices]
    .sort(
      (one, other) =>
        RANK[one.alert.severity] - RANK[other.alert.severity] ||
        Date.parse(other.alert.firedAt) - Date.parse(one.alert.firedAt),
    )
    .slice(0, AT_ONCE);

  return (
    <div className={styles.stack} data-testid="alert-notices">
      {shown.map((notice) => (
        <Notice
          key={notice.id}
          alert={notice.alert}
          onOpen={() => {
            open('alerts');
            // The corner is for what has not been looked at yet, and opening the panel is
            // looking: the alarm is at the top of it, with everything this notice could not fit.
            dismiss(notice.id);
          }}
          onDismiss={() => dismiss(notice.id)}
        />
      ))}
    </div>
  );
}

function Notice({
  alert,
  onOpen,
  onDismiss,
}: {
  alert: AlertDto;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const critical = alert.severity === 'critical';

  // On mount rather than on firing, so a notice that waited behind three others is read rather
  // than expired before it was drawn.
  useEffect(() => {
    if (critical) return;

    const timer = window.setTimeout(onDismiss, FADES_AFTER_MS);

    return () => window.clearTimeout(timer);
  }, [critical, onDismiss]);

  return (
    <div
      className={styles.notice}
      data-testid="alert-notice"
      data-severity={alert.severity}
      /* An alert interrupts and a status waits its turn, which is exactly the difference between
         these two: one of them is why somebody has to stop what they are doing. */
      role={critical ? 'alert' : 'status'}
    >
      <button
        type="button"
        className={styles.body}
        aria-label={`Open the ${alert.ruleName} alert on ${alert.topic}`}
        onClick={onOpen}
      >
        <span className={styles.level}>{SAID[alert.severity]}</span>
        <span className={styles.topic}>{alert.topic}</span>
        <span className={styles.rule}>{alert.ruleName}</span>
        <span className={styles.reason}>{alert.reason}</span>
      </button>

      <button
        type="button"
        className={styles.shut}
        aria-label={`Dismiss the ${alert.ruleName} alert`}
        onClick={onDismiss}
      >
        ×
      </button>
    </div>
  );
}
