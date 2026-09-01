import { describe, expect, it } from 'vitest';
import type { ReconnectStatus } from '../../types/api';
import { arrived, secondsUntil } from './reconnectView';

/**
 * The one piece of arithmetic in this feature, and the one place a clock can go wrong.
 *
 * `nextAttemptAt` and `now` are both the server's. Their difference is a duration; adding that to
 * this machine's clock at the moment of arrival is what makes the countdown right on a browser
 * whose clock is not the server's.
 */
describe('a reconnect status arriving', () => {
  const status = (over: Partial<ReconnectStatus> = {}): ReconnectStatus => ({
    enabled: true,
    active: true,
    attempt: 2,
    nextAttemptAt: '2026-09-02T21:00:08.000Z',
    now: '2026-09-02T21:00:00.000Z',
    gaveUp: false,
    ...over,
  });

  it('turns the gap into a deadline on this machine clock', () => {
    const view = arrived(status(), 5_000);

    expect(view.dueAt).toBe(13_000);
  });

  // The whole reason `now` is on the wire. A browser two minutes behind the server would
  // otherwise draw the skew between them as time remaining.
  it('is unmoved by a clock that disagrees with the server', () => {
    const skewed = arrived(
      status({ nextAttemptAt: '2001-01-01T00:00:08.000Z', now: '2001-01-01T00:00:00.000Z' }),
      5_000,
    );

    expect(skewed.dueAt).toBe(13_000);
  });

  it('has no deadline when no attempt is scheduled', () => {
    expect(arrived(status({ nextAttemptAt: null })).dueAt).toBeNull();
  });

  // A NaN deadline draws as 'NaNs'. The raw instant is no better — it is on the other machine's
  // clock — so the honest answer is no countdown at all.
  it('has no deadline when the instants will not parse', () => {
    expect(arrived(status({ nextAttemptAt: 'not a date' })).dueAt).toBeNull();
    expect(arrived(status({ now: '' })).dueAt).toBeNull();
  });

  it('keeps everything else the server said', () => {
    const view = arrived(status({ attempt: 7, gaveUp: true, enabled: false }));

    expect(view.attempt).toBe(7);
    expect(view.gaveUp).toBe(true);
    expect(view.enabled).toBe(false);
  });
});

describe('the countdown', () => {
  it('rounds up, so a deadline just over a second away reads as two', () => {
    expect(secondsUntil(1_100, 0)).toBe(2);
    expect(secondsUntil(1_000, 0)).toBe(1);
  });

  // A deadline that has passed means the attempt is due and the answer has not come back — a real
  // state a ladder spends time in, and not one to draw as a negative number counting up.
  it('never goes below zero', () => {
    expect(secondsUntil(0, 9_000)).toBe(0);
  });
});
