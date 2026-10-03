import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Minimal stand-in for the @microsoft/signalr parts hub.ts touches, for deterministic retries.
let startImpl: () => Promise<void>;
let closeCallback: (() => void) | undefined;

let startCount = 0;

/** What the connection was told to listen for, by the name the server sends it under. */
let listening = new Map<string, unknown>();

class FakeConnection {
  on(event: string, handler: unknown) {
    listening.set(event, handler);
  }
  off(event: string, handler: unknown) {
    if (listening.get(event) === handler) listening.delete(event);
  }
  onreconnecting() {}
  onreconnected() {}
  onclose(callback: () => void) {
    closeCallback = callback;
  }
  start() {
    startCount++;
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
  startCount = 0;
  listening = new Map();
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

  // Both recovery paths can answer for one failure — start() rejecting, and onclose firing behind
  // it — and two retry loops racing means the loser calls start() on a connection the winner has
  // already brought up. The real client rejects that with 'not in the Disconnected state', so the
  // loser goes on retrying every five seconds for as long as the page is open.
  it('runs one retry loop even when both recovery paths fire for the same failure', async () => {
    startImpl = () => Promise.reject(new Error('api not up yet'));
    const sut = createSignalRHub();
    let reconnectedCount = 0;
    sut.subscribe({ reconnected: () => reconnectedCount++ });

    await expect(sut.start()).rejects.toThrow('api not up yet');
    // The same failure reaching the other path.
    closeCallback?.();
    await Promise.resolve();

    startImpl = () => Promise.resolve();
    await vi.advanceTimersByTimeAsync(5000);

    expect(reconnectedCount).toBe(1);

    // And the loop is done: nothing is still calling start() behind the connection that came up.
    const settled = startCount;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(startCount).toBe(settled);
  });

  // SignalR hands a message to the handler registered under the name the server sent it by, so a
  // name a letter off is a handler that never runs, with nothing anywhere to say so. These are the
  // two a flow's Sound and Notify nodes send.
  it('listens for the tones and the notices a flow asks for, and stops with the rest', () => {
    const sut = createSignalRHub();
    const flowSound = () => {};
    const flowNotice = () => {};

    const stop = sut.subscribe({ flowSound, flowNotice });

    expect(listening.get('flowSound')).toBe(flowSound);
    expect(listening.get('flowNotice')).toBe(flowNotice);

    stop();

    expect([...listening.keys()]).toEqual([]);
  });
});
