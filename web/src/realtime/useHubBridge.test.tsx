import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '../api/queryKeys';
import { MAX_LOG_ENTRIES, runFor, useLogStore } from '../stores/logStore';
import { useHealthStore } from '../stores/healthStore';
import { usePauseStore } from '../stores/pauseStore';
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
  useHealthStore.setState({ arrived: 0, spentMs: 0, dropped: 0 });
});

afterEach(() => vi.unstubAllGlobals());

/**
 * Runs frames until nothing more is scheduled: the queue hands over a frame's worth at a time
 * and books the next frame itself, so one pass over the array is no longer the whole drain.
 */
function runFrames(limit = 1000) {
  for (let ran = 0; frames.length > 0; ran++) {
    if (ran > limit) throw new Error('the queue never emptied');
    frames.shift()!();
  }
}

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

    // In batches, the way the hub sends them, all arriving before a single frame has run — and
    // handed over across as many frames as the rate takes, which is the point: the burst lands
    // whole, but no one frame carries the whole of it.
    const start = performance.now();
    for (let i = 0; i < burst.length; i += 256) hub.emit('messagesReceived', burst.slice(i, i + 256));
    runFrames();
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
    runFrames();

    expect(arrivals()).toHaveLength(0);
  });

  // The loss nothing on this side can count: the messages never arrived. The server has always
  // kept the figure and nothing ever asked for it, so a console quietly short of topics looked
  // exactly like a quiet broker.
  it('takes the count of what the server had to drop, and says so', () => {
    const hub = createFakeHub();
    renderBridge(hub);

    hub.emit('messagesDropped', 12);

    expect(useHealthStore.getState().dropped).toBe(12);

    const said = useLogStore.getState().commands[0];
    expect(said.kind).toBe('fault');
    expect(said.verb).toBe('Messages dropped');
    expect(said.body).toContain('12 messages');
  });

  // A console that is behind stays behind, so the total arrives on nearly every batch. The figure
  // has to keep up; the log does not, or it fills with one sentence and buries the traffic.
  it('keeps the figure current without writing a line for every batch', () => {
    const hub = createFakeHub();
    renderBridge(hub);

    hub.emit('messagesDropped', 1);
    hub.emit('messagesDropped', 2);
    hub.emit('messagesDropped', 3);

    expect(useHealthStore.getState().dropped).toBe(3);
    expect(useLogStore.getState().commands).toHaveLength(1);
  });

  // A total that has not moved is the same total, and says nothing new.
  it('says nothing when the count is unchanged', () => {
    const hub = createFakeHub();
    renderBridge(hub);

    hub.emit('messagesDropped', 4);
    useLogStore.getState().clear();
    hub.emit('messagesDropped', 4);

    expect(useLogStore.getState().commands).toHaveLength(0);
  });

  // The queue was not the only thing left holding another broker's traffic. The tree started
  // again on its own while the log kept every run behind it, so a selection made on the broker
  // just left went on drawing that broker's messages under a lamp reading Connected to the new
  // one — the log's own clear() existed for this and nothing ever called it.
  it('empties the log when a connection starts the tree again', () => {
    const hub = createFakeHub();
    renderBridge(hub);

    hub.emit('messagesReceived', [message('sensors/one'), message('sensors/two')]);
    runFrames();
    expect(arrivals()).toHaveLength(2);

    act(() => useTopicTreeStore.getState().reset());

    expect(arrivals()).toHaveLength(0);
    expect(useLogStore.getState().held).toBe(0);
  });

  // Cleared inside reset(), so anything the connection records after it stands. Connecting pushes
  // its 'Connected' line straight after resetting the tree, and a clear that ran later would take
  // the one line explaining why the pane had just emptied.
  it('keeps a command recorded after the reset', () => {
    const hub = createFakeHub();
    renderBridge(hub);

    useLogStore.getState().push({ kind: 'ok', verb: 'Subscribed', topic: 'sensors/#' });

    act(() => {
      useTopicTreeStore.getState().reset();
      useLogStore.getState().push({ kind: 'ok', verb: 'Connected' });
    });

    expect(useLogStore.getState().commands.map((entry) => entry.verb)).toEqual(['Connected']);
  });
});

// The console-wide stop. What it stops is the taking in, not the broker: messages go on
// arriving and are queued rather than thrown away, because what went past while the reader was
// looking is what they stopped the console to look at. The queue has a ceiling and comes in a
// frame at a time, which is what makes keeping it affordable.
describe('while the console is stopped', () => {
  beforeEach(() => usePauseStore.setState({ paused: false, waiting: 0, lost: 0 }));

  it('takes nothing in', () => {
    const hub = createFakeHub();
    renderBridge(hub);
    usePauseStore.setState({ paused: true });

    hub.emit('messagesReceived', [message('sensors/one'), message('sensors/two')]);
    runFrames();

    expect(useLogStore.getState().held).toBe(0);
    expect(useTopicTreeStore.getState().root.subTopics).toBe(0);
  });

  it('says how many are waiting', () => {
    const hub = createFakeHub();
    renderBridge(hub);
    usePauseStore.setState({ paused: true });

    hub.emit('messagesReceived', [message('a'), message('b'), message('c')]);

    expect(usePauseStore.getState().waiting).toBe(3);
  });

  it('keeps what was already queued when it is pressed', () => {
    const hub = createFakeHub();
    renderBridge(hub);

    hub.emit('messagesReceived', [message('a'), message('b')]);
    usePauseStore.getState().toggle();
    runFrames();

    expect(useLogStore.getState().held).toBe(0);
    expect(usePauseStore.getState().waiting).toBe(2);
  });

  // The whole point of keeping them: five thousand messages behind a stop are five thousand
  // rows in the log and five thousand readings under the topics, not a number in a tooltip.
  it('writes everything it held onto the topics once it is let go', () => {
    const hub = createFakeHub();
    renderBridge(hub);
    usePauseStore.getState().toggle();

    hub.emit('messagesReceived', [message('sensors/one', '1'), message('sensors/two', '2')]);
    hub.emit('messagesReceived', [message('sensors/one', '3')]);
    usePauseStore.getState().toggle();
    runFrames();

    expect(useLogStore.getState().held).toBe(3);
    expect(runFor(useLogStore.getState().byTopic, 'sensors/one')).toHaveLength(2);
    expect(useTopicTreeStore.getState().root.subTopics).toBeGreaterThan(0);
    expect(usePauseStore.getState().waiting).toBe(0);
  });

  it('takes them again once it is let go', () => {
    const hub = createFakeHub();
    renderBridge(hub);
    usePauseStore.getState().toggle();
    usePauseStore.getState().toggle();

    hub.emit('messagesReceived', [message('sensors/one')]);
    runFrames();

    expect(useLogStore.getState().held).toBe(1);
    expect(usePauseStore.getState().waiting).toBe(0);
  });

  // The case this was rebuilt for: five thousand behind a stop, and five thousand on the topics
  // when it is let go — over three frames, so no single frame carries the lot.
  it('lands five thousand held messages, over as many frames as the rate takes', () => {
    const hub = createFakeHub();
    renderBridge(hub);
    usePauseStore.getState().toggle();

    const stopped = Array.from({ length: 5_000 }, (_, n) =>
      message(`sensors/${n % 50}/reading`, String(n)),
    );
    // In batches, the way the hub sends them.
    for (let at = 0; at < stopped.length; at += 256) {
      hub.emit('messagesReceived', stopped.slice(at, at + 256));
    }

    expect(useLogStore.getState().held).toBe(0);
    expect(usePauseStore.getState().waiting).toBe(5_000);

    usePauseStore.getState().toggle();
    let ran = 0;
    while (frames.length > 0) {
      frames.shift()!();
      ran++;
    }

    expect(useLogStore.getState().held).toBe(5_000);
    expect(useTopicTreeStore.getState().root.children.get('sensors')?.subTopics).toBe(50);
    expect(usePauseStore.getState().waiting).toBe(0);
    expect(usePauseStore.getState().lost).toBe(0);
    expect(ran).toBe(3);
  });

  // The one thing a held queue does not survive, and should not: a connection. The tree starts
  // again when one is made, and what was queued behind the stop was meant for the tree that has
  // just gone — another broker's traffic, or this one's from before its retained messages
  // refilled the tree. Handing it over then would write older readings over newer ones.
  it('lets go of what it held when a connection starts the tree again', () => {
    const hub = createFakeHub();
    renderBridge(hub);
    usePauseStore.getState().toggle();

    hub.emit('messagesReceived', [message('sensors/one'), message('sensors/two')]);
    expect(usePauseStore.getState().waiting).toBe(2);

    // What connecting does, and the reason the queue is no longer about anything.
    act(() => useTopicTreeStore.getState().reset());

    expect(usePauseStore.getState().waiting).toBe(0);
    expect(usePauseStore.getState().lost).toBe(2);

    usePauseStore.getState().toggle();
    runFrames();

    expect(useLogStore.getState().held).toBe(0);
    expect(useTopicTreeStore.getState().root.subTopics).toBe(0);
  });

  // A stop that is let go and pressed again before the queue has drained keeps the rest: the
  // reader has stopped it a second time, not thrown away what they stopped it for.
  it('holds the rest when it is pressed again mid-drain', () => {
    const hub = createFakeHub();
    renderBridge(hub);
    usePauseStore.getState().toggle();

    // More than one frame's worth, so the drain cannot finish in the frame below.
    const many = Array.from({ length: 3_000 }, (_, n) => message(`sensors/${n}`));
    hub.emit('messagesReceived', many);
    usePauseStore.getState().toggle();
    frames.shift()!();
    usePauseStore.getState().toggle();
    runFrames();

    expect(useLogStore.getState().held).toBe(2_000);
    expect(usePauseStore.getState().waiting).toBe(1_000);
  });
});
