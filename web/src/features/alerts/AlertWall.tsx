import { useAlertStore } from '../../stores/alertStore';
import type { AlertDto, AlertSeverity } from '../../types/api';
import type { PanelId } from '../panels';
import { clock, RANK } from './AlertsPanel';
import styles from './AlertWall.module.css';

/** The level in words. The wall is not a place where colour may be the only signal. */
const SAID: Record<AlertSeverity, string> = {
  info: 'info',
  warn: 'warning',
  critical: 'critical',
};

/**
 * What is on fire, down the right, whatever else the console is doing.
 *
 * This replaced a stack of notices in the bottom corner. The stack was a way of interrupting:
 * three at a time, six seconds each, and nothing at all for an alarm that was already standing
 * when the console opened — because a notice is news, and what was already true is not news.
 *
 * That rule is right for an interruption and wrong for a console. It meant the one question this
 * tool exists to answer — is anything wrong right now — had no answer on screen unless the reader
 * happened to be looking in the six seconds after it changed. The rail's badge counted, and
 * counting is not answering; the panel knew everything, and was shut.
 *
 * So the wall holds no state of its own. There is no list of what has been shown, no timer, and
 * no way to take a row off it. It draws the engine's standing alarms, in the order that matters,
 * and it is empty exactly when nothing is wrong.
 */
export function AlertWall({ open }: { open: (id: PanelId) => void }) {
  const active = useAlertStore((state) => state.active);

  // Loudest first, then newest. The same order the corner used, and for the same reason: a
  // critical is never pushed down the column by two warnings that arrived after it.
  const standing = [...active].sort(
    (one, other) =>
      RANK[one.severity] - RANK[other.severity] ||
      Date.parse(other.firedAt) - Date.parse(one.firedAt),
  );

  return (
    <aside
      className={styles.wall}
      data-testid="alert-wall"
      aria-label="Alarms"
      /* One live region for the column rather than a role on every row. A row that announced
         itself would announce itself again every time a louder alarm sorted above it, and a
         reader would be read the whole standing set on each arrival. Additions only, so what is
         spoken is what has just started. */
      role="log"
      aria-live="polite"
      aria-relevant="additions"
    >
      {standing.length === 0 ? (
        // The column stays. A wall that vanished when it was empty would widen the console on
        // every alarm and narrow it again afterwards, moving the ground under the reader once
        // per fire — and would leave 'nothing is wrong' and 'this feature is off' looking alike.
        <p className={styles.quiet}>Nothing is alarming.</p>
      ) : (
        standing.map((alert) => (
          <Row key={alert.id} alert={alert} onOpen={() => open('alerts')} />
        ))
      )}
    </aside>
  );
}

/**
 * One alarm.
 *
 * The whole row is the way into the panel, so the whole row is a button — a target the size of
 * the row rather than a link hidden in one line of it. It carries what can be read at a glance
 * and stops there: how bad, when, where, which rule, and why. Muting, resolving and the history
 * are the panel's, and the row is how the reader gets to it.
 */
function Row({ alert, onOpen }: { alert: AlertDto; onOpen: () => void }) {
  return (
    <button
      type="button"
      className={styles.row}
      data-testid="alert-wall-row"
      data-severity={alert.severity}
      aria-label={`Open the ${alert.ruleName} alert on ${alert.topic}`}
      onClick={onOpen}
    >
      <span className={styles.head}>
        <span className={styles.level}>{SAID[alert.severity]}</span>
        {/* The corner never said this: a notice was only ever seconds old. A row that has stood
            all afternoon is a different fact from one that has just gone up. */}
        <span className={styles.clock} data-testid="alert-wall-clock">
          {clock(alert.firedAt)}
        </span>
      </span>
      <span className={styles.topic} data-testid="alert-wall-topic">
        {alert.topic}
      </span>
      <span className={styles.rule}>{alert.ruleName}</span>
      <span className={styles.reason}>{alert.reason}</span>
    </button>
  );
}
