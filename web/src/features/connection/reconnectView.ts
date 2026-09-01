import type { ReconnectStatus } from '../../types/api';

/**
 * A status with its deadline moved onto this machine's clock.
 *
 * The conversion happens once, when the payload arrives, and never in a component. Two reasons,
 * and the second is the one that decides it:
 *
 * - The server's clock is not the browser's. `nextAttemptAt` and `now` are both the server's, so
 *   their difference is a duration; adding that to `Date.now()` at the moment of arrival gives a
 *   deadline this machine can count down to, whatever the skew between them.
 * - A payload sits in the query cache until the next one replaces it, which over a thirty-second
 *   rung is a long time. A component that converted at render would be fine; one that read a
 *   'seconds remaining' computed at send would show a stale figure for as long as it stood. The
 *   deadline is the form that stays true no matter when it is read.
 */
export type ReconnectView = ReconnectStatus & {
  /** When the next attempt is due, in `Date.now()` milliseconds. Null when none is scheduled. */
  dueAt: number | null;
};

/** Stamps an arriving status with a deadline on this machine's clock. */
export function arrived(status: ReconnectStatus, receivedAt = Date.now()): ReconnectView {
  return { ...status, dueAt: dueAtOn(status, receivedAt) };
}

function dueAtOn(status: ReconnectStatus, receivedAt: number): number | null {
  if (!status.nextAttemptAt) return null;

  const due = Date.parse(status.nextAttemptAt);
  const sent = Date.parse(status.now);

  // A payload whose instants will not parse is one this console cannot count down for, and a NaN
  // deadline draws as 'NaNs'. Falling back to the raw instant is wrong too — it is on the other
  // machine's clock — so the honest answer is no countdown, and the block says 'shortly' instead.
  if (Number.isNaN(due) || Number.isNaN(sent)) return null;

  return receivedAt + (due - sent);
}

/**
 * Whole seconds left, never below zero.
 *
 * A deadline that has passed means the attempt is due and the answer has not come back yet —
 * which is a real state a ladder spends time in, and 'in 0s' is what it should read as rather
 * than a negative number counting up.
 */
export const secondsUntil = (dueAt: number, now = Date.now()) =>
  Math.max(0, Math.ceil((dueAt - now) / 1000));
