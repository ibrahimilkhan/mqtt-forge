import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useLogStore } from '../../stores/logStore';
import { useSelectionStore } from '../../stores/selectionStore';
import { useTopicTreeStore } from '../../stores/topicTreeStore';
import { server } from '../../test/server';
import { SubscribePanel } from './SubscribePanel';

function renderPanel() {
  // Subscribe button is disabled without a live broker.
  server.use(http.get('/api/connection', () => HttpResponse.json({ state: 'Connected' })));

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(<SubscribePanel onClose={vi.fn()} />, { wrapper });
}

beforeEach(() => {
  useLogStore.getState().clear();
  useTopicTreeStore.getState().reset();
  useSelectionStore.getState().clear();
});

describe('SubscribePanel', () => {
  it('lists the active filters', async () => {
    server.use(http.get('/api/subscriptions', () => HttpResponse.json(['sensors/#', 'devices/+/state'])));

    renderPanel();

    // By role, not by text: the filter box is a textarea, so its own contents answer a text
    // query too and 'sensors/#' would match the box rather than the chip.
    expect(await screen.findByRole('button', { name: 'sensors/#' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'devices/+/state' })).toBeInTheDocument();
  });

  it('sends the filter and the chosen QoS', async () => {
    let sent: unknown;
    server.use(
      http.post('/api/subscriptions', async ({ request }) => {
        sent = await request.json();
        return new HttpResponse(null, { status: 202 });
      }),
    );

    renderPanel();
    await userEvent.click(await screen.findByRole('radio', { name: 'QoS 1' }));
    await userEvent.click(screen.getByRole('button', { name: 'Subscribe' }));

    await waitFor(() => expect(sent).toEqual({ topicFilter: 'sensors/#', qos: 1 }));
  });

  it('unsubscribes from the chip that was dismissed', async () => {
    let removed: string | null = null;
    server.use(
      http.get('/api/subscriptions', () => HttpResponse.json(['sensors/#'])),
      http.delete('/api/subscriptions', ({ request }) => {
        removed = new URL(request.url).searchParams.get('topicFilter');
        return new HttpResponse(null, { status: 204 });
      }),
    );

    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'Unsubscribe from sensors/#' }));

    await waitFor(() => expect(removed).toBe('sensors/#'));
  });

  it('clears the unsubscribed topics out of the tree', async () => {
    server.use(
      http.get('/api/subscriptions', () => HttpResponse.json(['sensors/#', 'devices/#'])),
      http.delete('/api/subscriptions', () => new HttpResponse(null, { status: 204 })),
    );
    useTopicTreeStore.getState().apply([
      {
        topic: 'sensors/temp',
        payload: '1',
        mode: 'text',
        size: 1,
        qos: 0,
        retain: false,
        receivedAt: '2026-08-09T10:00:00Z',
      },
      {
        topic: 'devices/a',
        payload: '1',
        mode: 'text',
        size: 1,
        qos: 0,
        retain: false,
        receivedAt: '2026-08-09T10:00:00Z',
      },
    ]);

    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'Unsubscribe from sensors/#' }));

    await waitFor(() =>
      expect(useTopicTreeStore.getState().root.children.has('sensors')).toBe(false),
    );
    // The other subscription is untouched, and so is what it put on screen.
    expect(useTopicTreeStore.getState().root.children.has('devices')).toBe(true);
  });

  it('logs the subscription with its QoS stamp', async () => {
    server.use(http.post('/api/subscriptions', () => new HttpResponse(null, { status: 202 })));

    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'Subscribe' }));

    await waitFor(() =>
      expect(useLogStore.getState().commands[0]).toMatchObject({
        kind: 'ok',
        verb: 'Subscribed',
        topic: 'sensors/#',
        stamps: ['QoS 0'],
      }),
    );
  });

  it('logs a fault when the broker is not connected', async () => {
    server.use(
      http.post('/api/subscriptions', () =>
        HttpResponse.json(
          { title: 'Not connected', detail: 'Connect to a broker before subscribing.' },
          { status: 400 },
        ),
      ),
    );

    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'Subscribe' }));

    await waitFor(() =>
      expect(useLogStore.getState().commands[0]).toMatchObject({
        kind: 'fault',
        verb: 'Subscribe failed',
        body: 'Connect to a broker before subscribing.',
      }),
    );
  });

  it('ignores extra clicks fired while a subscribe is already in flight', async () => {
    let calls = 0;
    server.use(
      http.post('/api/subscriptions', async () => {
        calls += 1;
        await delay(20);
        return new HttpResponse(null, { status: 202 });
      }),
    );

    renderPanel();
    const button = await screen.findByRole('button', { name: 'Subscribe' });
    await waitFor(() => expect(button).not.toBeDisabled());

    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(button).not.toBeDisabled());
    expect(calls).toBe(1);
  });

  it('ignores extra clicks on the same chip while its unsubscribe is already in flight', async () => {
    let calls = 0;
    server.use(
      http.get('/api/subscriptions', () => HttpResponse.json(['sensors/#'])),
      http.delete('/api/subscriptions', async () => {
        calls += 1;
        await delay(20);
        return new HttpResponse(null, { status: 204 });
      }),
    );

    renderPanel();
    const button = await screen.findByRole('button', { name: 'Unsubscribe from sensors/#' });

    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(calls).toBe(1));
  });

  it('releases a chip whose unsubscribe failed even when another chip was dismissed in the same tick', async () => {
    const calls: string[] = [];
    server.use(
      http.get('/api/subscriptions', () => HttpResponse.json(['aaa/#', 'bbb/#'])),
      http.delete('/api/subscriptions', ({ request }) => {
        calls.push(new URL(request.url).searchParams.get('topicFilter')!);
        return HttpResponse.json({ title: 'fault' }, { status: 400 });
      }),
    );

    renderPanel();
    const aaa = await screen.findByRole('button', { name: 'Unsubscribe from aaa/#' });
    const bbb = await screen.findByRole('button', { name: 'Unsubscribe from bbb/#' });

    // Same tick: both keys must pass the guard independently.
    fireEvent.click(aaa);
    fireEvent.click(bbb);

    await waitFor(() => expect(calls).toEqual(['aaa/#', 'bbb/#']));

    // Both failed and the chips survive; aaa/# must not be stuck disabled forever.
    fireEvent.click(aaa);

    await waitFor(() => expect(calls).toEqual(['aaa/#', 'bbb/#', 'aaa/#']));
  });

  describe('filters that are already up', () => {
    const filterBox = () => screen.getByLabelText('Topic filter');

    it('will not send a filter that is already subscribed', async () => {
      server.use(http.get('/api/subscriptions', () => HttpResponse.json(['sensors/#'])));

      renderPanel();

      // The note first: the button starts disabled anyway while the connection query is in
      // flight, so it only says something once the filter list has landed.
      expect(await screen.findByText('Already subscribed to that filter.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Subscribe' })).toBeDisabled();
    });

    it('sends only the filters of a pasted list that are not up yet', async () => {
      let sent: unknown;
      server.use(
        http.get('/api/subscriptions', () => HttpResponse.json(['a/#'])),
        http.post('/api/subscriptions/batch', async ({ request }) => {
          sent = await request.json();
          return new HttpResponse(null, { status: 202 });
        }),
      );

      renderPanel();
      await userEvent.clear(filterBox());
      await userEvent.type(filterBox(), 'a/#{Enter}b/#{Enter}c/#');

      const button = await screen.findByRole('button', { name: 'Subscribe to 2' });
      expect(screen.getByText('1 already subscribed — only the rest will be sent.')).toBeInTheDocument();
      await userEvent.click(button);

      await waitFor(() =>
        expect(sent).toEqual({
          filters: [
            { topicFilter: 'b/#', qos: 0 },
            { topicFilter: 'c/#', qos: 0 },
          ],
        }),
      );
    });
  });

  describe('subscribing to a list at once', () => {
    const filterBox = () => screen.getByLabelText('Topic filter');

    it('sends a pasted list as one batched packet instead of one call each', async () => {
      const batches: unknown[] = [];
      let singles = 0;
      server.use(
        http.post('/api/subscriptions/batch', async ({ request }) => {
          batches.push(await request.json());
          return new HttpResponse(null, { status: 202 });
        }),
        http.post('/api/subscriptions', () => {
          singles += 1;
          return new HttpResponse(null, { status: 202 });
        }),
      );

      renderPanel();
      await userEvent.clear(filterBox());
      await userEvent.type(filterBox(), 'a/#{Enter}b/#{Enter}c/#');
      await userEvent.click(screen.getByRole('button', { name: 'Subscribe to 3' }));

      await waitFor(() => expect(batches).toHaveLength(1));
      expect(batches[0]).toEqual({
        filters: [
          { topicFilter: 'a/#', qos: 0 },
          { topicFilter: 'b/#', qos: 0 },
          { topicFilter: 'c/#', qos: 0 },
        ],
      });
      expect(singles).toBe(0);
    });

    it('says how many it is about to send', async () => {
      renderPanel();
      await userEvent.clear(filterBox());
      await userEvent.type(filterBox(), 'a/#, b/#');

      expect(await screen.findByRole('button', { name: 'Subscribe to 2' })).toBeInTheDocument();
    });

    it('has nothing to send from an empty box', async () => {
      renderPanel();
      await userEvent.clear(filterBox());

      await waitFor(() => expect(screen.getByRole('button', { name: 'Subscribe' })).toBeDisabled());
    });

    it('logs the batch as one line rather than one per filter', async () => {
      server.use(
        http.post('/api/subscriptions/batch', () => new HttpResponse(null, { status: 202 })),
      );

      renderPanel();
      await userEvent.clear(filterBox());
      await userEvent.type(filterBox(), 'a/#{Enter}b/#');
      await userEvent.click(screen.getByRole('button', { name: 'Subscribe to 2' }));

      await waitFor(() =>
        expect(useLogStore.getState().commands[0]).toMatchObject({
          kind: 'ok',
          verb: 'Subscribed',
          topic: '2 filters',
        }),
      );
    });
  });
});

// Building a filter meant reading a topic off the tree and typing it back in by hand, one
// segment at a time, with the tree right there on screen. A click writes it instead.
describe('picking a topic into the box', () => {
  const box = () => screen.getByRole('textbox', { name: 'Topic filter' });
  const pick = (selection: { label: string; filter: string; topic?: string }) =>
    act(() => useSelectionStore.getState().select(selection));

  it('writes a topic picked off the tree', async () => {
    renderPanel();
    pick({ label: 'plant/line1/temp', filter: 'plant/line1/temp/#', topic: 'plant/line1/temp' });

    await waitFor(() => expect(box()).toHaveValue('plant/line1/temp'));
  });

  // A branch stands for everything under it, and that is what the tree hands over.
  it('writes a branch as the subtree it covers', async () => {
    renderPanel();
    pick({ label: 'plant/line1', filter: 'plant/line1/#', topic: 'plant/line1/#' });

    await waitFor(() => expect(box()).toHaveValue('plant/line1/#'));
  });

  it('adds a second pick rather than replacing the first', async () => {
    renderPanel();
    pick({ label: 'a/x', filter: 'a/x/#', topic: 'a/x' });
    await waitFor(() => expect(box()).toHaveValue('a/x'));
    pick({ label: 'b/y', filter: 'b/y/#', topic: 'b/y' });

    await waitFor(() => expect(box()).toHaveValue('a/x\nb/y'));
  });

  it('keeps what the reader typed and adds under it', async () => {
    renderPanel();
    await userEvent.clear(box());
    await userEvent.type(box(), 'typed/#');
    pick({ label: 'a/x', filter: 'a/x/#', topic: 'a/x' });

    await waitFor(() => expect(box()).toHaveValue('typed/#\na/x'));
  });

  // The broker row is the connection, not a topic — it carries no topic to write.
  it('writes nothing for a pick that is not a topic', async () => {
    renderPanel();
    const before = (box() as HTMLTextAreaElement).value;
    pick({ label: 'broker:1883', filter: '#' });

    await waitFor(() => expect(box()).toHaveValue(before));
  });

  // The other way in, and the one on this panel: the chips are right under the box.
  it('writes a filter clicked on its own chip', async () => {
    server.use(http.get('/api/subscriptions', () => HttpResponse.json(['plant/line1/#'])));

    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'plant/line1/#' }));

    await waitFor(() => expect(box()).toHaveValue('plant/line1/#'));
  });

  // Opening the panel over a selection made earlier is not a click on anything.
  it('does not write a selection that was already made before it opened', async () => {
    act(() => useSelectionStore.getState().select({ label: 'old/one', filter: 'old/one/#', topic: 'old/one' }));

    renderPanel();

    await waitFor(() => expect(box()).not.toHaveValue('old/one'));
  });
});
