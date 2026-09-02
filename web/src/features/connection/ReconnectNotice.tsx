import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { reconnectNow, stopReconnecting } from '../../api/connection';
import { queryKeys } from '../../api/queryKeys';
import { useConnectionState } from '../../api/useConnectionState';
import { useReconnectStatus } from '../../api/useReconnectStatus';
import { logFault } from '../../stores/logStore';
import { useLinkWatchStore } from '../../stores/linkWatchStore';
import styles from './ReconnectNotice.module.css';
import { describeFailureReason } from './connectFailure';
import { arrived, secondsUntil, type ReconnectView } from './reconnectView';

/**
 * What happened to the link, and what is being done about it.
 *
 * The five things this block exists for, and they are one feature: reconnect is an option rather
 * than a policy the app decided by itself; while it is trying it says so; while it is trying it
 * can be stopped; a link that drops because of a fault brings the reader here; and a link that
 * comes back does not close the panel out from under them — it says what broke and that it is
 * back.
 *
 * It has four faces and never more than one at a time:
 *
 * - **working** — an outage the supervisor is climbing its ladder for, counting down to the next
 *   rung, with Try now and Stop.
 * - **stopped** — an outage nobody is working on, because the reader stopped it or because the
 *   option is off. One button: Reconnect.
 * - **back** — it dropped and it is back. What broke it, how long it was gone, and a way to put
 *   the notice away.
 *
 * There used to be a fourth, 'quiet': a live link with the auto-reconnect switch on it and nothing
 * else. It is gone, and the switch with it. Over a live link the panel's whole job is to report
 * what is up, and a switch about a thing that is not happening was the loudest control on a screen
 * describing a connection that was perfectly fine. The switch now stands with the form, where it
 * is only on screen while there is no link — see AutoReconnectSwitch.
 */
export function ReconnectNotice() {
  const { state, failure } = useConnectionState();
  const { status } = useReconnectStatus();
  const watch = useLinkWatchStore();
  const queryClient = useQueryClient();

  // Every one of the three writes answers with the status it produced, so the cache is written
  // from the answer rather than invalidated and re-fetched. The hub sends the same payload a beat
  // later and they agree; a refetch would put a round trip between the click and the screen.
  const write = (status: ReconnectView) => queryClient.setQueryData(queryKeys.reconnect, status);

  const tryNow = useMutation({
    mutationFn: reconnectNow,
    onSuccess: (result) => write(arrived(result)),
    onError: (error) => logFault('Reconnect failed', error),
  });

  const stop = useMutation({
    mutationFn: stopReconnecting,
    onSuccess: (result) => write(arrived(result)),
    onError: (error) => logFault('Could not stop reconnecting', error),
  });

  /**
   * A link that went down, as opposed to one that never came up.
   *
   * Both halves are needed. The watch is what makes it a *drop* — a Connect the reader pressed
   * and that failed is not one, and this block has nothing to say about it: the form that made
   * the attempt is right there with its own sentence under it. And the live state is what makes
   * it *now*, so a watch still holding an outage the reader has not dismissed does not put a
   * "the link is down" block over a link that is up.
   */
  const down = state === 'Faulted' && watch.droppedAt !== null;
  const back = watch.recoveredAt !== null;
  const busy = tryNow.isPending || stop.isPending;

  // Which face. Order matters: a recovery outranks an outage, because by the time there is one to
  // report the outage is over — and a link that is up outranks both, except that 'back' IS a link
  // that is up and is the whole point of the notice.
  const face: Face | null = back
    ? 'back'
    : down && status.active
      ? 'working'
      : down
        ? 'stopped'
        : null;

  // Nothing to say. A console that has never connected, or one mid-attempt with no history, gets
  // no block at all rather than an empty one.
  if (face === null) return null;

  // The failure is read from the watch rather than from the connection state, and that is the
  // whole reason the watch exists: the API sends no failure once the link is up, so a recovery
  // notice reading the live state would have nothing to say about what broke.
  const broke = watch.failure ?? failure ?? undefined;
  const why = broke ? describeFailureReason(broke.reason, broke) : undefined;
  const where = broke ? `${broke.host}:${broke.port}` : undefined;

  return (
    <section className={styles.notice} data-state={face} aria-live="polite">
      {face === 'working' && (
        <>
          <div className={styles.head}>
            <h3 className={styles.title}>Reconnecting</h3>
            <Countdown status={status} />
          </div>
          {/* The reason rides in the same sentence as the drop it explains, which is how anybody
              would say it out loud — and which stops the cause being set smaller and paler than
              the mechanical fact that there was one. */}
          <p className={styles.detail}>
            {where ? `The link to ${where} dropped` : 'The link dropped'}
            {why ? `: ${lowerFirst(why)}` : '.'}
          </p>
          <p className={styles.was}>
            {status.attempt > 0
              ? `${status.attempt} ${status.attempt === 1 ? 'try has' : 'tries have'} failed so far.`
              : 'Trying again shortly.'}
          </p>
          <div className={styles.actions}>
            <button type="button" onClick={() => tryNow.mutate()} disabled={busy}>
              Try now
            </button>
            {/* Stops this outage, not the option. The switch below is the standing answer, and
                keeping them apart is what lets 'stop, I am looking at it' mean that and nothing
                more — the next connection that works puts the supervisor back to work. */}
            <button type="button" className="ghost" onClick={() => stop.mutate()} disabled={busy}>
              Stop trying
            </button>
          </div>
        </>
      )}

      {face === 'stopped' && (
        <>
          <div className={styles.head}>
            <h3 className={styles.title}>Not reconnecting</h3>
          </div>
          <p className={styles.detail}>
            {where ? `The link to ${where} is down` : 'The link is down'}
            {why ? `: ${lowerFirst(why)}` : '.'}
          </p>
          <p className={styles.was}>
            {status.enabled
              ? 'Reconnecting was stopped, so nothing is being tried.'
              : 'Auto-reconnect is off, so nothing is being tried.'}
          </p>
          <div className={styles.actions}>
            <button type="button" onClick={() => tryNow.mutate()} disabled={busy}>
              Reconnect
            </button>
          </div>
        </>
      )}

      {face === 'back' && (
        <>
          <div className={styles.head}>
            <h3 className={styles.title}>Reconnected</h3>
            <span className={styles.counter}>{away(watch.droppedAt, watch.recoveredAt)}</span>
          </div>
          <p className={styles.detail}>
            {where ? `The link to ${where} came back.` : 'The link came back.'}
          </p>
          {/* What broke it, still on screen. A notice saying only that a link dropped and came
              back leaves the reader with the question they opened the panel with. */}
          {why && <p className={styles.was}>It had dropped: {lowerFirst(why)}</p>}
          <div className={styles.actions}>
            <button
              type="button"
              className="ghost"
              onClick={() => useLinkWatchStore.getState().dismiss()}
            >
              Dismiss
            </button>
          </div>
        </>
      )}

      {/* The switch was here too for a moment, on the two outage faces, and that was one switch
          too many: every state this block draws is a state with no link, and a panel with no link
          is showing the form — which carries the switch already, a few inches down. Two checkboxes
          for one setting on one screen is a reader wondering which of them is the real one. */}
    </section>
  );
}

type Face = 'working' | 'stopped' | 'back';

/**
 * Seconds to the next rung, ticking.
 *
 * Its own component so that the second that changes re-renders one span rather than the whole
 * block — and, more to the point, so the interval is only alive while there is something to count.
 */
function Countdown({ status }: { status: ReconnectView }) {
  const { dueAt } = status;
  const [, tick] = useState(0);

  useEffect(() => {
    if (dueAt === null) return;

    // Twice a second, not once. On a one-second timer the displayed figure can be a whole second
    // stale, which on the bottom rung of the ladder is the whole countdown.
    const timer = setInterval(() => tick((n) => n + 1), 500);

    return () => clearInterval(timer);
  }, [dueAt]);

  // No deadline is a real state — the attempt is running right now — and the honest thing to say
  // about a dial in flight is that it is in flight, not 'in 0s'.
  if (dueAt === null) return <span className={styles.counter}>trying…</span>;

  const left = secondsUntil(dueAt);

  return (
    <span className={styles.counter}>
      {left === 0 ? 'trying…' : `next try in ${left}s`}
    </span>
  );
}

/**
 * A sentence joined onto another one after a colon.
 *
 * Only the first letter, and only when the word is not one that is capitalised in its own right:
 * 'The broker closed the connection' becomes 'the broker closed…', while 'MQTT 5.0 was refused'
 * and a hostname keep the capital they came with. The describer writes each of these as a
 * standalone sentence, which is right where it is used alone.
 */
function lowerFirst(sentence: string): string {
  const [first, second] = [sentence[0] ?? '', sentence[1] ?? ''];

  // A second capital says the word is a name or an initialism, and lowering the first letter of
  // one of those is worse than the join it was meant to smooth.
  if (second && second === second.toUpperCase() && second !== second.toLowerCase()) return sentence;

  return first.toLowerCase() + sentence.slice(1);
}

/** How long it was gone, in the roundest words that are still true. */
function away(droppedAt: number | null, recoveredAt: number | null): string {
  if (droppedAt === null || recoveredAt === null) return '';

  const seconds = Math.max(0, Math.round((recoveredAt - droppedAt) / 1000));
  if (seconds < 60) return `gone for ${seconds}s`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `gone for ${minutes}m`;

  return `gone for ${Math.round(minutes / 60)}h`;
}
