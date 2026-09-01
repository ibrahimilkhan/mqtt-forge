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

  it('connecting is a rung or a reader dialling, and changes nothing', () => {
    saw('Connected');
    saw('Faulted', broke(), 1_000);

    saw('Connecting');

    expect(watch().droppedAt).toBe(1_000);
    expect(watch().openedByFault).toBe(true);
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
