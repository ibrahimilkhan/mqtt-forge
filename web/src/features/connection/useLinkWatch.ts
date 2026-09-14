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
  const { state, failure, link, answered, seenAt } = useConnectionState();
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
   * redial the supervisor made is the same new connection and gets no such reset: unchanged means
   * this is a link coming back on its own, and the return is marked rather than the tree started
   * again — a row that has heard nothing since is drawn faded, rather than a broker that came back
   * without its retained tree leaving old values looking current. Only a moved link, or the
   * reader's own Connect, still start the tree again.
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
  const linkAt = useRef<{ endpoint: string; since: string; generation: number } | null>(null);

  /**
   * The session a return was last marked for, so the effect that watches for a session this
   * console did not see begin does not mark the same return a second time: a redial is a new
   * session, and both effects see it.
   */
  const returnedSession = useRef<string | null>(null);

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
    // Read here for the same reason, and used for the opposite decision: a link the reader dialled
    // themselves is not a link that came back. See `dialled` in linkWatchStore.
    const dialled = watch.dialled;

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

    // Somebody hung up — this console or another one. Not a fault and not an outage, so the
    // notice stays away; but the subscriptions the server held are gone, and a console still
    // showing their chips is offering an x for a filter nobody holds. A line says it happened at
    // all, which for a hang-up from another console is the only trace there would otherwise be.
    if (state === 'Disconnected' && before === 'Connected') {
      linkAt.current = null;
      void queryClient.invalidateQueries({ queryKey: queryKeys.subscriptions });
      events.push({ kind: 'note', what: 'Link ended', detail: 'The connection was closed.' });
    }

    // Back, and the same broker. A Connect to a different broker while an outage is on is not
    // the dropped link returning — that line is the mutation's own 'Connected'.
    const sameBroker =
      !link ||
      !watch.failure ||
      (link.host === watch.failure.host && link.port === watch.failure.port);
    if (state === 'Connected' && dropped !== null && sameBroker) {
      // Started again since the drop means the reader's own Connect did it. Unchanged means this
      // link came back on its own — and the console keeps what it had.
      //
      // It used to start the tree again here, for a broker that restarted without its retained
      // tree and would otherwise leave its old values looking current. On a broker that resets
      // every link — mqtt.hsl.fi does, from some networks, every forty seconds — that threw away
      // the tree, the log, the Stop queue and every pause the reader had taken, over and over. The
      // return is marked instead, and a row that hears nothing after it is drawn faded.
      const tree = useTopicTreeStore.getState();
      if (treeAtDrop.current === tree.generation) {
        // Dated by when the console heard the link was back, not by when this effect got to it. A
        // row is faded against when its messages were received, which the hub bridge stamps as it
        // takes them in, and this effect runs only after React has drawn the new state — late
        // enough for a retained message the broker sent straight back to be received first, and
        // then faded as older than the return it came back with. `seenAt` is taken on the same
        // clock at the same point on the way in; the effect's own clock is left for an answer
        // written anywhere else, which carries none.
        tree.returned(seenAt ?? Date.now());
        returnedSession.current = link?.connectedAt ?? null;
      }
      treeAtDrop.current = null;

      // What the link came back listening to, asked again rather than assumed. The supervisor
      // puts the console's filters back, and a broker can refuse them on the way — a tightened
      // ACL is the ordinary way — in which case the panel's Filters chips and the summary's
      // Subscriptions row were left showing what this console asked for rather than what it has.
      // A reader looking at a green link and a quiet tree deserves to see the count that explains
      // it. The reader's own Connect invalidates the same key; a redial had nobody to do it.
      void queryClient.invalidateQueries({ queryKey: queryKeys.subscriptions });
      void queryClient.invalidateQueries({ queryKey: queryKeys.connection });

      // 'Link back' is the record of something happening on its own while nobody was looking.
      // The reader's own Connect is already in the record, written by the mutation that made it,
      // and a second line calling it a recovery would date the same act twice under two names.
      if (!dialled)
        events.push({
          kind: 'ok',
          what: `Link back · gone for ${away(dropped)}`,
        });
    }
    // `seenAt` is read above and not listed. It comes with the state it dates, so whenever this has
    // something to do the two are from the same answer — and a refetch that changes nothing about
    // the link still brings a new one, which is no reason to look at the link again.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seenAt dates the state, see above
  }, [state, failure, link, answered, queryClient]);

  // The link is not the one this console was watching — another broker, or the same broker on a
  // session this console never saw begin.
  //
  // The second half is the machine that slept. A laptop closed overnight wakes to a link that
  // dropped and came back hours ago: nothing on this side saw either, so the state still reads
  // Connected and every arrival of the old session is still on screen, under a green lamp, as
  // though it were current. `connectedAt` is the broker's own answer to 'is this the same
  // session', and a new one is marked as a return, the same as a drop this console did watch: a
  // row that has heard nothing since is drawn faded, rather than looking current.
  useEffect(() => {
    if (!answered || state !== 'Connected' || !link) return;

    const endpoint = formatEndpoint(link.host, link.port);
    const since = link.connectedAt;
    const tree = useTopicTreeStore.getState();
    const held = linkAt.current;

    if (held && (held.endpoint !== endpoint || held.since !== since)) {
      const moved = held.endpoint !== endpoint;
      // Unchanged generation means nobody has started the tree again since this console last saw
      // the link.
      if (held.generation === tree.generation) {
        if (moved) {
          // Another broker: the topics under the root are the old broker's, and this console is
          // the one to clear them.
          tree.reset();
          void queryClient.invalidateQueries({ queryKey: queryKeys.subscriptions });
          useBrokerEventsStore.getState().push({
            kind: 'note',
            what: `Link moved · ${endpoint}`,
            detail: `Another console pointed this server at ${endpoint}; the topics of ${held.endpoint} are gone.`,
          });
        } else if (returnedSession.current !== since) {
          // The same broker, on a session this console did not see begin — the machine that
          // slept. What arrived before it is still true of what arrived; it is marked, as a
          // return is, rather than thrown away — and dated the same way, by when the console
          // heard of it, for the reason given at the return above.
          tree.returned(seenAt ?? Date.now());
          returnedSession.current = since;
          void queryClient.invalidateQueries({ queryKey: queryKeys.subscriptions });
          useBrokerEventsStore.getState().push({
            kind: 'note',
            what: `New session · ${endpoint}`,
            detail:
              'The link was made again while this console was not watching; what arrived before it is drawn faded.',
          });
        }
      }
    }

    linkAt.current = { endpoint, since, generation: useTopicTreeStore.getState().generation };
    // Unlisted for the reason given on the effect above. A run here is not free either: each one
    // writes the tree's generation into `linkAt`, and that is what the next session is judged by.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seenAt dates the link, see above
  }, [answered, state, link, queryClient]);

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
