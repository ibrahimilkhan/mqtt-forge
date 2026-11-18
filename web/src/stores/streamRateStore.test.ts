import { beforeEach, describe, expect, it } from 'vitest';
import { RATE_SECONDS, useStreamRateStore } from './streamRateStore';

beforeEach(() => useStreamRateStore.getState().reset());

const store = () => useStreamRateStore.getState();

describe('the stream rate', () => {
  it('turns what arrived in a second into a reading', () => {
    store().arrived(120);
    store().arrived(80);
    store().tick();

    expect(store().readings).toEqual([200]);
  });

  it('starts each second from nothing', () => {
    store().arrived(200);
    store().tick();
    store().tick();

    expect(store().readings).toEqual([200, 0]);
  });

  // Counting is on the path every batch takes, and a line woken by every batch would be redrawn
  // at the broker's rate.
  it('wakes nobody by counting, only by closing a second', () => {
    let woken = 0;
    const stop = useStreamRateStore.subscribe(() => woken++);

    store().arrived(500);
    store().arrived(500);
    expect(woken).toBe(0);

    store().tick();
    expect(woken).toBe(1);
    stop();
  });

  it('keeps a minute and lets the oldest go', () => {
    for (let second = 1; second <= RATE_SECONDS + 5; second++) {
      store().arrived(second);
      store().tick();
    }

    expect(store().readings).toHaveLength(RATE_SECONDS);
    expect(store().readings[0]).toBe(6);
    expect(store().readings.at(-1)).toBe(RATE_SECONDS + 5);
  });

  it('forgets the last stream when a new one starts', () => {
    store().arrived(300);
    store().tick();
    store().arrived(40);

    store().reset();
    store().tick();

    expect(store().readings).toEqual([0]);
  });
});
