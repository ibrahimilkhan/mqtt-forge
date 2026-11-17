import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { useWindows } from './features/monitor/useWindows';
import { useZoomStore } from './features/monitor/useZoom';
import { createFakeHub } from './realtime/fakeHub';
import { useTopicTreeStore } from './stores/topicTreeStore';
import type { MqttMessage } from './types/api';

/**
 * The rail's Topics row: a way straight to the tree from wherever the reader is.
 *
 * Not a panel. It opens nothing, shuts whatever stands over the tree — the broker panel takes the
 * whole workspace — and puts the keyboard in the tree.
 */
const message = (topic: string): MqttMessage => ({
  topic,
  payload: '21.5',
  qos: 0,
  retain: false,
  receivedAt: '2026-11-11T09:00:00Z',
});

const openConsole = async () => {
  const hub = createFakeHub();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <App hub={hub} />
    </QueryClientProvider>,
  );
  await screen.findByRole('button', { name: 'Close Broker panel' });
  return hub;
};

const topicsRow = () =>
  within(screen.getByRole('navigation', { name: 'Panels' })).getByRole('button', { name: 'Topics' });

beforeEach(() => {
  useTopicTreeStore.getState().reset();
  useZoomStore.getState().close();
  for (const one of useWindows.getState().windows) useWindows.getState().close(one.id);
});

describe('the rail’s Topics row', () => {
  it('shuts the open panel and puts the focus on the tree', async () => {
    await openConsole();

    await userEvent.click(topicsRow());

    expect(screen.queryByRole('region', { name: 'Broker panel' })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(document.activeElement?.closest('section')).toContainElement(
        screen.getByRole('heading', { name: 'Topics' }),
      ),
    );
  });

  it('lands on a row of the tree when the tree has any', async () => {
    const hub = await openConsole();
    act(() => hub.emit('messagesReceived', [message('plant/kiln/temp')]));

    await userEvent.click(topicsRow());

    await waitFor(() => expect(document.activeElement).toHaveAttribute('data-pick'));
  });

  it('puts away a chart thrown open over the tree', async () => {
    await openConsole();
    act(() => useZoomStore.getState().toggle());
    expect(useZoomStore.getState().zoomed).toBe(true);

    await userEvent.click(topicsRow());

    expect(useZoomStore.getState().zoomed).toBe(false);
  });

  // An action, not a panel: there is nothing it holds open, so it says nothing about being open.
  it('has no expanded state', async () => {
    await openConsole();

    expect(topicsRow()).not.toHaveAttribute('aria-expanded');
  });
});
