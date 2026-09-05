import { useQueryClient } from '@tanstack/react-query';
import { formatEndpoint } from './address';
import { useEffect, useRef } from 'react';
import { queryKeys } from '../../api/queryKeys';
import { useConnectionState } from '../../api/useConnectionState';
import { useReconnectStatus } from '../../api/useReconnectStatus';
import { useBrokerEventsStore } from '../../stores/brokerEventsStore';
import { useTopicTreeStore } from '../../stores/topicTreeStore';
import { useLinkWatchStore } from '../../stores/linkWatchStore';
import type { ConnectionState } from '../../types/api';

/**
 * Feeds the link watch from the connection state, once, for the whole console.
 *
 * Mounted from App rather than from the Broker panel, and that is the point: the panel is shut
 * most of the time, and a drop that happened while it was shut is exactly the drop the reader
 * most needs told about. A watcher that only ran while the panel was open would miss every one
 * of them.
 *
 * It also writes the broker events the log cannot: a drop, a link coming back, and each try the
 * ladder makes. The reader's own commands — Connect, Disconnect, Subscribe — are written by the
 * mutations that make them and reach the events through the log; these three are the ones with
 * no command behind them.
 */
export function useLinkWatch() {
  const { state, failure, link, answered } = useConnectionState();
  const { status, answered: statusAnswered } = useReconnectStatus();
  const queryClient = useQueryClient();

  // What was last seen, so that a transition can be told from a repeat. Undefined until the
  // API has answered once: a console reloaded over a broken link is looking at a drop that
  // happened before it opened, and writing 'Link dropped' at that moment would date it wrong.
  const seen = useRef<ConnectionState | undefined>(undefined);
  const tries = useRef<number | null>(null);

  /**
   * The tree's generation at the moment the link dropped, so a recovery can tell whether anybody
   * has started it again since.
   *
   * A hand Connect resets the tree — new connection, new tree, retained messages refill it. A
   * redial the supervisor made is the same new connection and had no such reset, so a broker that
   * came back without its retained tree (no `persistence`, which is every default container) left
   * its old values on screen looking current. A monitoring console showing state the broker no
   * longer holds is wrong in the one thing it is for.
   */
  const treeAtDrop = useRef<number | null>(null);

  /**
   * The broker the console last saw itself connected to, and the tree's generation at the time.
   *
   * One server holds one link, and more than one console can be looking at it — the desktop
   * window and the phone the QR code opened, most often. When one of them moves the link to
   * another broker, the others are simply told 'Connected' to somewhere else: their tree kept
   * every topic of the broker that is gone and merged the new one's retained messages into it,
   * under a root relabelled with the new address. A monitor showing one broker's readings under
   * another broker's name is wrong in the way that matters most.
   *
   * The generation says whether this console's own Connect already started the tree again, so a
   * link the reader moved themselves is not reset twice — see the recovery above.
   */
  const linkAt = useRef<{ endpoint: string; generation: number } | null>(null);

  useEffect(() => {
    // Before the API has answered, `state` is the standing-in Disconnected rather than an
    // observation — and Disconnected is the one value that clears the store. A console reloaded
    // over a broken link would wipe the outage it was reloaded to look at.
    if (!answered) return;

    const before = seen.current;
    seen.current = state;

    // Read before `saw` moves it: whether this Connected is a link coming back is a question
    // about the outage the watch was holding, and `saw` closes that outage.
    const watch = useLinkWatchStore.getState();
    const dropped = watch.droppedAt !== null && watch.recoveredAt === null ? watch.droppedAt : null;

    watch.saw(state, failure, undefined, link);

    if (before === undefined || before === state) return;
    const events = useBrokerEventsStore.getState();

    // The endpoint and not the reason. The reason is the notice's sentence, on screen a few
    // lines away for as long as the outage is, and one sentence said twice on one screen reads
    // as two things having gone wrong. The record keeps the fact and the time; the reader's own
    // failed connects reach it with their reasons through the log.
    if (state === 'Faulted' && before === 'Connected') {
      treeAtDrop.current = useTopicTreeStore.getState().generation;
      events.push({
        kind: 'fault',
        what: failure ? `Link dropped · ${formatEndpoint(failure.host, failure.port)}` : 'Link dropped',
      });
    }

    // Back, and the same broker. A Connect to a different broker while an outage is on is not
    // the dropped link returning — that line is the mutation's own 'Connected'.
    const sameBroker =
      !link ||
      !watch.failure ||
      (link.host === watch.failure.host && link.port === watch.failure.port);
    if (state === 'Connected' && dropped !== null && sameBroker) {
      // Started again since the drop means the reader's own Connect did it, and resetting a
      // second time would clear the log out from under the 'Connected' line that mutation had
      // just pushed. Unchanged means this link came back on its own, and the tree is still the
      // old broker's — so it is started again here, and the retained messages refill it.
      const tree = useTopicTreeStore.getState();
      if (treeAtDrop.current === tree.generation) tree.reset();
      treeAtDrop.current = null;

      // What the link came back listening to, asked again rather than assumed. The supervisor
      // puts the console's filters back, and a broker can refuse them on the way — a tightened
      // ACL is the ordinary way — in which case the panel's Filters chips and the summary's
      // Subscriptions row were left showing what this console asked for rather than what it has.
      // A reader looking at a green link and a quiet tree deserves to see the count that explains
      // it. The reader's own Connect invalidates the same key; a redial had nobody to do it.
      void queryClient.invalidateQueries({ queryKey: queryKeys.subscriptions });
      void queryClient.invalidateQueries({ queryKey: queryKeys.connection });

      events.push({
        kind: 'ok',
        what: `Link back · gone for ${away(dropped)}`,
      });
    }
  }, [state, failure, link, answered, queryClient]);

  // The link moved to another broker, by a hand that is not this console's.
  useEffect(() => {
    if (!answered || state !== 'Connected' || !link) return;

    const endpoint = formatEndpoint(link.host, link.port);
    const tree = useTopicTreeStore.getState();
    const held = linkAt.current;

    if (held && held.endpoint !== endpoint) {
      // Nobody has started the tree again since this console last saw the old link, so the
      // topics under it are the old broker's and this console is the one to clear them.
      if (held.generation === tree.generation) {
        tree.reset();
        useBrokerEventsStore.getState().push({
          kind: 'note',
          what: `Link moved · ${endpoint}`,
          detail: `Another console pointed this server at ${endpoint}; the topics of ${held.endpoint} are gone.`,
        });
      }
    }

    linkAt.current = { endpoint, generation: useTopicTreeStore.getState().generation };
  }, [answered, state, link]);

  // The link is down with an outage the server is working on — or has stopped working on, which
  // is still an outage — and this console holds no record of it. It did not see it begin; the
  // supervisor did, and says when. Without this a reload mid-outage drew a form with a red line
  // and no notice, no countdown and no way to stop the ladder. Its own effect rather than a
  // branch of the one above, because the two answers it needs — the link's state and the
  // supervisor's status — arrive as two queries in either order, and `resume` is a no-op once
  // the watch holds anything of its own.
  useEffect(() => {
    if (!answered || state !== 'Faulted' || status.sinceAt === null) return;

    useLinkWatchStore.getState().resume(failure, status.sinceAt);
  }, [answered, state, failure, status.sinceAt]);

  // One line per try. The supervisor announces after each attempt with the count so far, and a
  // count that went up while the link is still down is a try that failed. Only while it is
  // still down: the announcement for the try that worked carries the same count, and it arrives
  // a beat after the state has already said Connected.
  useEffect(() => {
    // Not before the API has answered: the stand-in status says zero tries, and seeding from it
    // made the real answer look like four tries happening at once.
    if (!statusAnswered) return;

    const before = tries.current;
    tries.current = status.attempt;

    // The first status a console sees is a count, not a try: a reload mid-outage found four tries
    // already made and wrote four lines stamped with the moment it loaded.
    if (before === null) return;

    // One line per try, not one per render: two announcements landing in one render batch
    // skipped a number, and a record reading 1, 2, 4 looks like a try that was never made.
    if (status.attempt > before && state === 'Faulted') {
      // One line for the run of tries, counting up in place — see BrokerEvent.key. A rung every
      // thirty seconds is a hundred and twenty lines an hour, and the drop they are all about
      // would be off the end of the list by the time anybody looked.
      useBrokerEventsStore.getState().push({
        kind: 'fault',
        key: 'reconnect-tries',
        what: status.attempt === 1 ? 'Try 1 failed' : `${status.attempt} tries failed`,
      });
    }
  }, [status.attempt, statusAnswered, state]);

  // And the one thing a reader can do to the ladder from the notice, so the record says it was
  // done rather than showing tries that simply stop.
  const gaveUp = useRef(false);
  useEffect(() => {
    if (status.gaveUp && !gaveUp.current) {
      useBrokerEventsStore.getState().push({ kind: 'note', what: 'Reconnecting stopped' });
    }
    gaveUp.current = status.gaveUp;
  }, [status.gaveUp]);

  // The supervisor declining an outage is worth a line: it is the moment the retries a reader
  // was watching stop on their own, and without it they would read as simply having stopped.
  const declined = useRef(false);
  useEffect(() => {
    if (status.declined && !declined.current) {
      useBrokerEventsStore.getState().push({
        kind: 'note',
        what: 'Not retried',
        detail: 'The link is down for a reason a redial would not fix.',
      });
    }
    declined.current = status.declined ?? false;
  }, [status.declined]);
}

/** How long it was gone, in the roundest words that are still true. */
function away(droppedAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - droppedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  return `${Math.round(minutes / 60)}h`;
}
