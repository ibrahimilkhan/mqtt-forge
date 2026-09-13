import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WireLog } from './features/monitor/WireLog';
import { SubscribePanel } from './features/subscribe/SubscribePanel';
import { TopicTree } from './features/topics/TopicTree';
import { createFakeHub } from './realtime/fakeHub';
import { useHubBridge } from './realtime/useHubBridge';
import { useHoldStore } from './stores/holdStore';
import { useLogStore } from './stores/logStore';
import { useSelectionStore } from './stores/selectionStore';
import { useTopicTreeStore } from './stores/topicTreeStore';
import { server } from './test/server';
import type { ActiveFilter, MqttMessage } from './types/api';

/**
 * Letting go of a subscription while the console is holding some of what it brought in.
 *
 * An unsubscribe is a reader saying they are done with a set of topics, so it takes them from
 * every place the console keeps one — the tree, the log's runs, and whatever the reader paused —
 * exactly as Clear does. It used to prune the tree alone: the broker row went on showing the old
 * runs, and a paused row vanished with its control while its hold stayed on, unseen.
 */

let frames: Array<() => void>;
let subscribed: ActiveFilter[];

beforeEach(() => {
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => frames.push(callback));
  vi.stubGlobal('cancelAnimationFrame', () => {});

  useLogStore.getState().clear();
  useTopicTreeStore.getState().reset();
  useTopicTreeStore.setState({ defaultOpen: true });
  useSelectionStore.getState().clear();
  useHoldStore.getState().release();

  subscribed = [
    { topicFilter: 'sensors/#', console: true, rules: false },
    { topicFilter: 'plant/#', console: true, rules: false },
  ];

  server.use(
    http.get('/api/connection', () =>
      HttpResponse.json({
        state: 'Connected',
        connection: { host: 'localhost', port: 1883, clientId: 'console' },
      }),
    ),
    http.get('/api/subscriptions', () => HttpResponse.json(subscribed)),
    http.delete('/api/subscriptions', ({ request }) => {
      const gone = new URL(request.url).searchParams.get('topicFilter');
      subscribed = subscribed.filter((one) => one.topicFilter !== gone);
      return new HttpResponse(null, { status: 204 });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

const message = (topic: string, payload: string): MqttMessage => ({
  topic,
  payload,
  qos: 0,
  retain: false,
  receivedAt: '2026-09-13T10:00:00Z',
});

function Console({ hub }: { hub: ReturnType<typeof createFakeHub> }) {
  useHubBridge(hub);

  return (
    <>
      <section data-testid="tree">
        <TopicTree broker="localhost:1883" />
      </section>
      <WireLog />
      <SubscribePanel onClose={() => {}} />
    </>
  );
}

function renderConsole() {
  const hub = createFakeHub();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={queryClient}>
      <Console hub={hub} />
    </QueryClientProvider>,
  );

  const send = (...sent: Array<[topic: string, payload: string]>) => {
    act(() => hub.emit('messagesReceived', sent.map(([topic, payload]) => message(topic, payload))));
    act(() => {
      while (frames.length > 0) frames.shift()!();
    });
  };

  return { send };
}

const tree = () => within(screen.getByTestId('tree'));
const rowOf = (segment: string) =>
  tree().getByText(segment).closest<HTMLElement>('[data-testid="tree-row"]')!;
const rowFor = (segment: string) => tree().queryByText(segment);
const pick = (segment: string) => userEvent.click(tree().getByText(segment));

const unsubscribe = async (filter: string) => {
  await userEvent.click(await screen.findByRole('button', { name: `Unsubscribe from ${filter}` }));
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: `Unsubscribe from ${filter}` })).not.toBeInTheDocument(),
  );
};

describe('unsubscribing', () => {
  it('takes the topics from the log as well as from the tree', async () => {
    const { send } = renderConsole();
    send(['sensors/temp', '21'], ['plant/kiln', '900']);

    await unsubscribe('sensors/#');

    expect(rowFor('temp')).toBeNull();
    expect(useLogStore.getState().byTopic.has('sensors/temp')).toBe(false);
    expect(useLogStore.getState().byTopic.has('plant/kiln')).toBe(true);
  });

  it('lets go of a hold on topics nothing is subscribed to any more', async () => {
    const { send } = renderConsole();
    send(['sensors/temp', '21'], ['plant/kiln', '900']);
    await pick('temp');
    await userEvent.click(within(rowOf('temp')).getByRole('button', { name: 'Pause the pane' }));

    await unsubscribe('sensors/#');

    expect(useHoldStore.getState().held.size).toBe(0);
    expect(screen.queryByTestId('body')).not.toBeInTheDocument();

    send(['sensors/temp', '30']);
    expect(rowOf('temp')).toHaveTextContent('30');
  });

  it('keeps the broker row paused, without the rows it no longer hears', async () => {
    const { send } = renderConsole();
    send(['sensors/temp', '21'], ['plant/kiln', '900']);
    await pick('localhost:1883');
    await userEvent.click(within(rowOf('localhost:1883')).getByRole('button', { name: 'Pause the pane' }));
    send(['plant/kiln', '910']);

    await unsubscribe('sensors/#');

    expect(useHoldStore.getState().held.has('#')).toBe(true);
    expect(rowFor('sensors')).toBeNull();
    expect(rowOf('kiln')).toHaveTextContent('900');
    expect(rowOf('localhost:1883')).toHaveTextContent('1 topic · 1 message');
  });
});
