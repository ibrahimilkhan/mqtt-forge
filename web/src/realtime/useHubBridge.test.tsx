import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '../api/queryKeys';
import { MAX_LOG_ENTRIES, runFor, useLogStore } from '../stores/logStore';
import { useTopicTreeStore } from '../stores/topicTreeStore';
import type { MqttMessage } from '../types/api';
import { createFakeHub } from './fakeHub';
import { useHubBridge } from './useHubBridge';

const message = (topic: string, payload = '1'): MqttMessage => ({
  topic,
  payload,
  qos: 0,
  retain: false,
  receivedAt: '2026-07-26T10:00:00Z',
});

let frames: Array<() => void>;

beforeEach(() => {
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => frames.push(callback));
  vi.stubGlobal('cancelAnimationFrame', () => {});
  useLogStore.getState().clear();
  useTopicTreeStore.getState().reset();
});

afterEach(() => vi.unstubAllGlobals());

function renderBridge(hub: ReturnType<typeof createFakeHub>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const view = renderHook(() => useHubBridge(hub), { wrapper });
  return { ...view, queryClient };
}

/** The traffic the bridge fed into the store, newest first. */
const arrivals = () => runFor(useLogStore.getState().byTopic, '#');

describe('useHubBridge', () => {
  it('starts the hub on mount', () => {
    const hub = createFakeHub();

    renderBridge(hub);

    expect(hub.startCount).toBe(1);
  });

  it('feeds a frame of messages into both stores', () => {
    const hub = createFakeHub();
    renderBridge(hub);

    hub.emit('messagesReceived', [message('sensors/temp', '21.5'), message('sensors/humidity', '54')]);
    frames[0]();

    expect(arrivals()).toHaveLength(2);
    expect(useTopicTreeStore.getState().root.children.get('sensors')?.subTopics).toBe(2);
  });

  it('lands a binary arrival in both stores as hex', () => {
    const hub = createFakeHub();
    renderBridge(hub);

    // 'AaT/' is 01 A4 FF base64-encoded.
    hub.emit('messagesReceived', [
      { ...message('device/binary'), payload: 'AaT/', payloadEncoding: 'base64' },
    ]);
    frames[0]();

    expect(arrivals()[0]).toMatchObject({
      mode: 'hex',
      body: '01 A4 FF',
      stamps: expect.arrayContaining(['BIN']),
    });

    const node = useTopicTreeStore.getState().root.children.get('device')?.children.get('binary');
    expect(node).toMatchObject({ latestMode: 'hex', latestPayload: '01 A4 FF' });
  });

  it('writes a pushed connection state into the query cache', () => {
    const hub = createFakeHub();
    const { queryClient } = renderBridge(hub);

    hub.emit('connectionStateChanged', { state: 'Faulted' });

    expect(queryClient.getQueryData(queryKeys.connection)).toEqual({ state: 'Faulted' });
  });

  it('refetches after a reconnect, since the broker may have changed while the hub was down', () => {
    const hub = createFakeHub();
    const { queryClient } = renderBridge(hub);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    hub.emit('reconnected');

    expect(invalidate).toHaveBeenCalled();
  });

  it('holds up under a burst of thousands of messages landing before one frame flushes', () => {
    const hub = createFakeHub();
    renderBridge(hub);
    // Its own number, not the log's cap. The two were the same once and the assertion below
    // read as 'the log filled up', when what this is about is that none of the burst was lost
    // between the hub and the stores.
    const BURST = 5000;
    expect(BURST).toBeLessThanOrEqual(MAX_LOG_ENTRIES);
    const burst = Array.from({ length: BURST }, (_, i) => message(`sensors/${i % 50}/reading`, String(i)));

    // In batches, the way the hub sends them, all landing inside the same frame.
    const start = performance.now();
    for (let i = 0; i < burst.length; i += 256) hub.emit('messagesReceived', burst.slice(i, i + 256));
    frames[0]();
    const elapsedMs = performance.now() - start;

    expect(useLogStore.getState().held).toBe(BURST);
    expect(useTopicTreeStore.getState().root.children.get('sensors')?.subTopics).toBe(50);
    expect(elapsedMs).toBeLessThan(5000);
  });

  it('stops feeding the stores after unmount', () => {
    const hub = createFakeHub();
    const { unmount } = renderBridge(hub);

    hub.emit('messagesReceived', [message('a')]);
    unmount();
    frames.forEach((frame) => frame());

    expect(arrivals()).toHaveLength(0);
  });
});
