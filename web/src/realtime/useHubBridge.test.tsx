import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '../api/queryKeys';
import { useLogStore } from '../stores/logStore';
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

describe('useHubBridge', () => {
  it('starts the hub on mount', () => {
    const hub = createFakeHub();

    renderBridge(hub);

    expect(hub.startCount).toBe(1);
  });

  it('feeds a frame of messages into both stores', () => {
    const hub = createFakeHub();
    renderBridge(hub);

    hub.emit('messageReceived', message('sensors/temp', '21.5'));
    hub.emit('messageReceived', message('sensors/humidity', '54'));
    frames[0]();

    expect(useLogStore.getState().entries).toHaveLength(2);
    expect(useTopicTreeStore.getState().root.children.get('sensors')?.subMessages).toBe(2);
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

  it('stops feeding the stores after unmount', () => {
    const hub = createFakeHub();
    const { unmount } = renderBridge(hub);

    hub.emit('messageReceived', message('a'));
    unmount();
    frames.forEach((frame) => frame());

    expect(useLogStore.getState().entries).toHaveLength(0);
  });
});
