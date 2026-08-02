import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A minimal stand-in for the parts of @microsoft/signalr that hub.ts touches, so the
// retry behaviour can be driven deterministically instead of through a real socket.
let startImpl: () => Promise<void>;
let closeCallback: (() => void) | undefined;

class FakeConnection {
  on() {}
  off() {}
  onreconnecting() {}
  onreconnected() {}
  onclose(callback: () => void) {
    closeCallback = callback;
  }
  start() {
    return startImpl();
  }
}

vi.mock('@microsoft/signalr', () => ({
  HubConnectionBuilder: class {
    withUrl() {
      return this;
    }
    withAutomaticReconnect() {
      return this;
    }
    build() {
      return new FakeConnection();
    }
  },
}));

const { createSignalRHub } = await import('./hub');

beforeEach(() => {
  closeCallback = undefined;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createSignalRHub', () => {
  it('keeps retrying after the connection closes for good, and reports reconnected once it succeeds', async () => {
    startImpl = () => Promise.resolve();
    const sut = createSignalRHub();
    let reconnectingCount = 0;
    let reconnectedCount = 0;
    sut.subscribe({ reconnecting: () => reconnectingCount++, reconnected: () => reconnectedCount++ });
    await sut.start();

    // withAutomaticReconnect gave up; this is the callback it hands to onclose.
    startImpl = () => Promise.reject(new Error('api still down'));
    closeCallback?.();
    await Promise.resolve();

    expect(reconnectingCount).toBe(1);
    expect(reconnectedCount).toBe(0);

    // Still down after one retry interval — no false "reconnected".
    startImpl = () => Promise.reject(new Error('api still down'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(reconnectedCount).toBe(0);

    // The API comes back; the next scheduled retry should succeed.
    startImpl = () => Promise.resolve();
    await vi.advanceTimersByTimeAsync(5000);
    expect(reconnectedCount).toBe(1);
  });

  it('retries when the very first start fails, not only after a later drop', async () => {
    startImpl = () => Promise.reject(new Error('api not up yet'));
    const sut = createSignalRHub();
    let reconnectingCount = 0;
    let reconnectedCount = 0;
    sut.subscribe({ reconnecting: () => reconnectingCount++, reconnected: () => reconnectedCount++ });

    await expect(sut.start()).rejects.toThrow('api not up yet');
    expect(reconnectingCount).toBe(1);

    startImpl = () => Promise.resolve();
    await vi.advanceTimersByTimeAsync(5000);

    expect(reconnectedCount).toBe(1);
  });
});
