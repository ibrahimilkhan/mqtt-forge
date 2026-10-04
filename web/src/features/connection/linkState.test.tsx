import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { queryKeys } from '../../api/queryKeys';
import { useHubStatusStore } from '../../stores/hubStatusStore';
import type { ConnectionState } from '../../types/api';
import { arrived } from './reconnectView';
import { useLinkState, type LinkState } from './linkState';

/**
 * The six states, and which of them wins when more than one is true at once.
 *
 * All three of the overlaps below are the ordinary shape of an outage rather than edge cases: a
 * ladder mid-climb IS a link that is Faulted or Connecting by turns, and a console that has lost
 * its own server still holds a cache saying the broker was up. Which answer comes out is what the
 * Broker row wears through an outage, in the states a reader most wants it to be right about.
 */

// The store outlives a test, so a case that loses the hub must not leave it lost for the next.
beforeEach(() => useHubStatusStore.getState().setStatus('live'));

function state(
  connection: ConnectionState,
  reconnect: { active?: boolean; enabled?: boolean } = {},
): LinkState {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  query.setQueryData(queryKeys.connection, { state: connection, failure: null, connection: null });
  query.setQueryData(
    queryKeys.reconnect,
    arrived({
      enabled: true,
      active: false,
      attempt: 0,
      nextAttemptAt: null,
      gaveUp: false,
      now: '2026-09-12T00:00:00.000Z',
      ...reconnect,
    }),
  );

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={query}>{children}</QueryClientProvider>
  );

  return renderHook(() => useLinkState(), { wrapper }).result.current;
}

describe('the link state every readout reads', () => {
  it('takes the API at its word where nothing else is going on', () => {
    expect(state('Connected')).toBe('Connected');
    expect(state('Disconnected')).toBe('Disconnected');
    expect(state('Faulted')).toBe('Faulted');
  });

  // Its own word, because the thing a reader can do about it is different: a connect in flight
  // is waited out, and a fault is acted on.
  it('calls a connect in flight Waiting rather than Connecting', () => {
    expect(state('Connecting')).toBe('Waiting');
  });

  /* The state the rail's colours were rewritten for. A ladder walks the link through Faulted and
     Connecting by turns, once a rung, and a readout taking the link's own state would swing
     between red and amber for the length of the outage. Both of these must come out Retrying. */
  it('holds one word for a whole outage, whichever rung the ladder is on', () => {
    expect(state('Faulted', { active: true })).toBe('Retrying');
    expect(state('Connecting', { active: true })).toBe('Retrying');
  });

  // The flag stays up through the attempt that works. Without this guard a console that had just
  // come back would have read Retrying over a live link.
  it('stops saying Retrying the moment the link is back', () => {
    expect(state('Connected', { active: true })).toBe('Connected');
  });

  /* The console's own server, not the broker's. It outranks every answer below it because it is
     what makes those answers doubtful: the cache still says Connected, and nothing has been able
     to contradict it since the socket went. */
  it('says the console lost its own server before it says anything about the broker', () => {
    useHubStatusStore.getState().setStatus('reconnecting');

    expect(state('Connected')).toBe('Reconnecting');
    expect(state('Faulted', { active: true })).toBe('Reconnecting');
    expect(state('Disconnected')).toBe('Reconnecting');
  });
});
