import { beforeEach, describe, expect, it } from 'vitest';
import type { BrokerFailure } from '../types/api';
import { resetLinkWatch, useLinkWatchStore } from './linkWatchStore';

/**
 * The transition table, which is the whole of this store.
 *
 * Written against the store directly rather than through a rendered panel, because the question
 * here is exactly "what does this sequence of connection states mean" — and that is a question
 * with a table for an answer, not a screen.
 */
describe('what the console remembers about a link', () => {
  beforeEach(resetLinkWatch);

  const watch = () => useLinkWatchStore.getState();
  const saw = (state: Parameters<ReturnType<typeof watch>['saw']>[0],
               failure: BrokerFailure | null = null, now?: number) =>
    useLinkWatchStore.getState().saw(state, failure, now);

  const broke = (reason = 'brokerClosed'): BrokerFailure => ({
    reason,
    host: 'broker.local',
    port: 1883,
    clientId: 'console',
    useTls: false,
    transport: 'tcp',
    protocolVersion: 'v311',
  });

  // The difference the whole store turns on. A Connect somebody pressed and that failed is the
  // Broker panel's own business; it has the form that made the attempt and a sentence under it.
  it('a fault on a link that was never up is not a drop', () => {
    saw('Faulted', broke());

    expect(watch().droppedAt).toBeNull();
    expect(watch().openedByFault).toBe(false);
  });

  it('a fault on a link that was up is a drop, and it opens the panel', () => {
    saw('Connected');
    saw('Faulted', broke(), 1_000);

    expect(watch().droppedAt).toBe(1_000);
    expect(watch().openedByFault).toBe(true);
    expect(watch().failure?.reason).toBe('brokerClosed');
  });

  // A ladder puts the link back into Faulted once a rung. Re-stamping would say the outage began
  // at the last rung rather than at the drop — and would reopen a panel just closed.
  it('a ladder re-announcing the same outage does not restart it', () => {
    saw('Connected');
    saw('Faulted', broke(), 1_000);
    useLinkWatchStore.getState().released();

    saw('Connecting');
    saw('Faulted', broke(), 9_000);

    expect(watch().droppedAt).toBe(1_000);
    expect(watch().openedByFault).toBe(false);
  });

  // The first announcement of a drop carries whatever MQTTnet said; a later rung's refusal is
  // often the more specific of the two.
  it('a reason that arrives late is kept when the drop had none', () => {
    saw('Connected');
    saw('Faulted', null, 1_000);
    expect(watch().failure).toBeNull();

    saw('Faulted', broke('credentialsRejected'), 2_000);

    expect(watch().failure?.reason).toBe('credentialsRejected');
    expect(watch().droppedAt).toBe(1_000);
  });

  it('a link that comes back is a recovery, stamped', () => {
    saw('Connected');
    saw('Faulted', broke(), 1_000);

    saw('Connected', null, 5_000);

    expect(watch().recoveredAt).toBe(5_000);
    // And what broke it survives the recovery, which is the reason this store exists: the API
    // sends no failure once the link is up.
    expect(watch().failure?.reason).toBe('brokerClosed');
  });

  // A notice saying so on the first successful connect of a session would be the console
  // congratulating itself.
  // mqtt.hsl.fi takes the connection and then closes it over a wildcard; the reader goes to
  // localhost instead. localhost coming up is not hsl.fi coming back.
  it('a link to a different broker is not the dropped one coming back', () => {
    saw('Connected');
    saw('Faulted', broke('notPermitted'), 1_000);

    useLinkWatchStore.getState().saw('Connected', null, 5_000, { host: 'localhost', port: 1883 });

    expect(watch().recoveredAt).toBeNull();
    expect(watch().droppedAt).toBeNull();
    expect(watch().openedByFault).toBe(false);
    expect(watch().wasUp).toBe(true);
  });

  it('the same broker coming back is a recovery, whoever dialled it', () => {
    saw('Connected');
    saw('Faulted', broke(), 1_000);

    useLinkWatchStore.getState().saw('Connected', null, 5_000, { host: 'broker.local', port: 1883 });

    expect(watch().recoveredAt).toBe(5_000);
  });

  // A console that reloads mid-outage: the server says when it began, and the watch takes its
  // word — once, and only while it holds nothing of its own.
  it('resuming an outage the server reports draws it as a drop that opened the panel', () => {
    useLinkWatchStore.getState().resume(broke(), 1_000);

    expect(watch().droppedAt).toBe(1_000);
    expect(watch().openedByFault).toBe(true);
    expect(watch().failure?.reason).toBe('brokerClosed');
  });

  it('resuming never overwrites an outage the console saw itself', () => {
    saw('Connected');
    saw('Faulted', broke(), 1_000);

    useLinkWatchStore.getState().resume(broke('refused'), 5_000);

    expect(watch().droppedAt).toBe(1_000);
    expect(watch().failure?.reason).toBe('brokerClosed');
  });

  // A flapping broker, and a reader who does not press Dismiss between the flaps.
  it('a second drop after an un-dismissed recovery is a drop of its own', () => {
    saw('Connected');
    saw('Faulted', broke(), 1_000);
    saw('Connected', null, 5_000);
    expect(watch().recoveredAt).toBe(5_000);

    saw('Faulted', broke('refused'), 9_000);

    expect(watch().droppedAt).toBe(9_000);
    expect(watch().recoveredAt).toBeNull();
    expect(watch().failure?.reason).toBe('refused');
    expect(watch().openedByFault).toBe(true);
  });

  // ...and the panel the reader closed by hand during the first outage opens again for the
  // second, because a new drop is new news.
  it('a second drop reopens a panel the reader had released', () => {
    saw('Connected');
    saw('Faulted', broke(), 1_000);
    useLinkWatchStore.getState().released();
    saw('Connected', null, 5_000);

    saw('Faulted', broke(), 9_000);

    expect(watch().openedByFault).toBe(true);
  });

  // A broker that comes back with authentication switched on: it drops as one thing and then
  // refuses every rung as another, and the second is the one worth reading.
  it('keeps the newest reason beside the one that broke the link', () => {
    saw('Connected');
    saw('Faulted', broke('brokerShuttingDown'), 1_000);
    saw('Faulted', broke('credentialsRequired'), 3_000);

    expect(watch().failure?.reason).toBe('brokerShuttingDown');
    expect(watch().latest?.reason).toBe('credentialsRequired');
    expect(watch().droppedAt).toBe(1_000);
  });

  it('a rung that says nothing new leaves both reasons standing', () => {
    saw('Connected');
    saw('Faulted', broke('refused'), 1_000);
    saw('Faulted', undefined, 3_000);

    expect(watch().failure?.reason).toBe('refused');
    expect(watch().latest?.reason).toBe('refused');
  });

  it('a first connection is not a recovery', () => {
    saw('Connected', null, 5_000);

    expect(watch().recoveredAt).toBeNull();
  });

  it('a second poll of the same live link does not re-stamp the recovery', () => {
    saw('Connected');
    saw('Faulted', broke(), 1_000);
    saw('Connected', null, 5_000);

    saw('Connected', null, 9_000);

    expect(watch().recoveredAt).toBe(5_000);
  });

  // Hanging up on purpose ends the outage without recovering from it: there is nothing to tell
  // the reader that they do not already know.
  it('disconnecting by hand clears everything', () => {
    saw('Connected');
    saw('Faulted', broke(), 1_000);

    saw('Disconnected');

    expect(watch().droppedAt).toBeNull();
    expect(watch().recoveredAt).toBeNull();
    expect(watch().openedByFault).toBe(false);
    expect(watch().failure).toBeNull();
  });

  it('connecting mid-outage is a rung of the ladder, and changes nothing', () => {
    saw('Connected');
    saw('Faulted', broke(), 1_000);

    saw('Connecting');

    expect(watch().droppedAt).toBe(1_000);
    expect(watch().openedByFault).toBe(true);
  });

  // Measured: a Connect to a wrong password, pressed from a live link, read as that link
  // dropping — and the next Connect that worked as the wrong-password broker coming back.
  it('dialling by hand from a live link is leaving it on purpose, so a failed dial is not a drop', () => {
    saw('Connected');

    saw('Connecting');
    saw('Faulted', broke('credentialsRejected'), 1_000);

    expect(watch().droppedAt).toBeNull();
    expect(watch().openedByFault).toBe(false);
  });

  it('a dial that works after one that failed is a first connection, not a recovery', () => {
    saw('Connected');
    saw('Connecting');
    saw('Faulted', broke('credentialsRejected'), 1_000);

    saw('Connecting');
    saw('Connected', null, 5_000);

    expect(watch().recoveredAt).toBeNull();
    expect(watch().wasUp).toBe(true);
  });

  // Otherwise the very next drop would read as a first connect that failed, and tell nobody.
  it('dismissing a notice does not forget that a link has been up', () => {
    saw('Connected');
    saw('Faulted', broke(), 1_000);
    saw('Connected', null, 5_000);

    useLinkWatchStore.getState().dismiss();
    expect(watch().recoveredAt).toBeNull();

    saw('Faulted', broke(), 9_000);

    expect(watch().droppedAt).toBe(9_000);
    expect(watch().openedByFault).toBe(true);
  });

  it('a panel closed by hand is no longer held open by the fault that opened it', () => {
    saw('Connected');
    saw('Faulted', broke(), 1_000);

    useLinkWatchStore.getState().released();

    expect(watch().openedByFault).toBe(false);
    // The outage itself is still on, which is what the notice goes on reading.
    expect(watch().droppedAt).toBe(1_000);
  });

  // Two outages in one session, which is the ordinary case on a flaky link.
  it('a second outage is its own outage', () => {
    saw('Connected');
    saw('Faulted', broke('brokerClosed'), 1_000);
    saw('Connected', null, 2_000);
    useLinkWatchStore.getState().dismiss();

    saw('Faulted', broke('timeout'), 3_000);

    expect(watch().droppedAt).toBe(3_000);
    expect(watch().recoveredAt).toBeNull();
    expect(watch().failure?.reason).toBe('timeout');
  });
});

/**
 * A link the reader put back themselves.
 *
 * 'Reconnected · gone for 4m' is news about something that happened while nobody was looking. A
 * reader who pressed Stop trying and then Connect is looking at the button they pressed, and the
 * notice reads as the console taking credit for their click — over a sentence that is not even
 * true: nothing reconnected, somebody connected.
 */
describe('a dial the reader made during an outage', () => {
  beforeEach(resetLinkWatch);

  const watch = () => useLinkWatchStore.getState();
  const saw = (state: Parameters<ReturnType<typeof watch>['saw']>[0],
               failure: BrokerFailure | null = null) =>
    useLinkWatchStore.getState().saw(state, failure);

  const broke = (): BrokerFailure => ({
    reason: 'brokerClosed',
    host: 'broker.local',
    port: 1883,
    clientId: 'console',
    useTls: false,
    transport: 'tcp',
    protocolVersion: 'v311',
  });

  /** A link that was up and has gone: the state every case here starts from. */
  const anOutage = () => {
    saw('Connected');
    saw('Faulted', broke());
  };

  it('ends the outage instead of recovering from it', () => {
    anOutage();
    watch().dialling();

    saw('Connecting');
    saw('Connected');

    expect(watch().recoveredAt).toBeNull();
    expect(watch().droppedAt).toBeNull();
    // And the link is up, so the next fault is a drop again.
    expect(watch().wasUp).toBe(true);
  });

  it('leaves a link that came back on its own to say so', () => {
    anOutage();

    saw('Connecting');
    saw('Connected');

    expect(watch().recoveredAt).not.toBeNull();
  });

  it('is forgotten when the dial fails, so the ladder can still report a recovery', () => {
    anOutage();
    watch().dialling();

    // The reader's Connect went to a broker that is still down.
    saw('Faulted', broke());
    expect(watch().dialled).toBe(false);
    expect(watch().droppedAt).not.toBeNull();

    // And the rung that finally works is a recovery, because nobody dialled this one.
    saw('Connected');
    expect(watch().recoveredAt).not.toBeNull();
  });

  it('is not remembered from a connect made with no outage on', () => {
    // The console's very first Connect. Nothing has dropped, so there is nothing to take over —
    // and a flag left standing here would swallow the notice for a drop an hour later.
    watch().dialling();
    saw('Connected');
    expect(watch().dialled).toBe(false);

    saw('Faulted', broke());
    saw('Connected');

    expect(watch().recoveredAt).not.toBeNull();
  });

  it('goes with a hang-up', () => {
    anOutage();
    watch().dialling();

    saw('Disconnected');

    expect(watch().dialled).toBe(false);
  });
});
