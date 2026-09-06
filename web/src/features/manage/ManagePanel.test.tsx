import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { server } from '../../test/server';
import type { DecodedMessage } from '../../realtime/decodeIncoming';
import { useBrokerEventsStore } from '../../stores/brokerEventsStore';
import { useLogStore } from '../../stores/logStore';
import { useSelectionStore } from '../../stores/selectionStore';
import { useTopicTreeStore } from '../../stores/topicTreeStore';
import { useHoldStore } from '../monitor/useTraffic';
import { ManagePanel } from './ManagePanel';

const message = (topic: string, payload = '1', retain = false): DecodedMessage => ({
  topic,
  payload,
  mode: 'text',
  size: payload.length,
  qos: 0,
  retain,
  receivedAt: '2026-09-06T10:00:00Z',
});

const landed = (...messages: DecodedMessage[]) => {
  useLogStore.getState().appendReceived(messages);
  useTopicTreeStore.getState().apply(messages);
};

/** What a paused row is: a filter, the run frozen under it, and the tree beneath it. */
const pause = (path: string) =>
  useHoldStore
    .getState()
    .hold(
      `${path}/#`,
      useLogStore.getState().byTopic.get(path)?.newestFirst() ?? [],
      new Map(),
    );

beforeEach(() => {
  useLogStore.getState().clear();
  useTopicTreeStore.getState().reset();
  useHoldStore.getState().release();
  useBrokerEventsStore.getState().clear();
  useSelectionStore.getState().clear();
});

const panel = () => render(<ManagePanel onClose={() => {}} />);

describe('the screen for what is being held', () => {
  describe('the topics the reader has paused', () => {
    it('says there are none, and where one is taken', () => {
      panel();

      expect(screen.getByText(/Nothing is paused/)).toBeInTheDocument();
    });

    it('lists each of them by the topic it was taken on', () => {
      landed(message('plant/boiler/temp'), message('plant/pump/temp'));
      pause('plant/boiler/temp');
      pause('plant/pump/temp');

      panel();

      expect(screen.getByRole('button', { name: 'plant/boiler/temp' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'plant/pump/temp' })).toBeInTheDocument();
    });

    it('says how much each is holding, and how much has arrived behind it', async () => {
      landed(message('plant/boiler/temp', '21'));
      pause('plant/boiler/temp');
      act(() => landed(message('plant/boiler/temp', '22'), message('plant/boiler/temp', '23')));

      panel();

      const row = screen.getByRole('button', { name: 'plant/boiler/temp' }).closest('li')!;
      await waitFor(() => expect(within(row).getByText('1 held')).toBeInTheDocument());
      expect(within(row).getByText('2 behind')).toBeInTheDocument();
    });

    it('lets go of one of them', async () => {
      landed(message('plant/boiler/temp'), message('plant/pump/temp'));
      pause('plant/boiler/temp');
      pause('plant/pump/temp');
      panel();

      await userEvent.click(screen.getByRole('button', { name: 'Let go of plant/boiler/temp' }));

      expect([...useHoldStore.getState().held.keys()]).toEqual(['plant/pump/temp/#']);
    });

    it('lets go of every one of them at once', async () => {
      landed(message('a/one'), message('b/two'));
      pause('a/one');
      pause('b/two');
      panel();

      await userEvent.click(screen.getByRole('button', { name: 'Let go of all 2' }));

      expect(useHoldStore.getState().held.size).toBe(0);
    });

    // Somebody with six paused topics is reading this list because they cannot find them.
    it('takes the reader to the run when the topic is pressed', async () => {
      landed(message('plant/boiler/temp'));
      pause('plant/boiler/temp');
      panel();

      await userEvent.click(screen.getByRole('button', { name: 'plant/boiler/temp' }));

      expect(useSelectionStore.getState().selected?.filter).toBe('plant/boiler/temp/#');
    });

    it('offers no let-go-of-all for a single pause', () => {
      landed(message('a/one'));
      pause('a/one');
      panel();

      expect(screen.queryByRole('button', { name: /Let go of all/ })).not.toBeInTheDocument();
    });
  });

  describe('what the console is holding', () => {
    it('counts the messages, the topics and what they weigh', async () => {
      landed(message('a/one', 'x'.repeat(2048)), message('b/two', 'y'));
      useBrokerEventsStore.getState().push({ kind: 'ok', what: 'Connected' });

      panel();

      expect(screen.getByText('Messages').nextSibling).toHaveTextContent('2');
      expect(screen.getByText('Topics').nextSibling).toHaveTextContent('2');
      expect(screen.getByText('Payload').nextSibling).toHaveTextContent('2 kB of 500 MB');
      expect(screen.getByText('Broker events').nextSibling).toHaveTextContent('1');
    });

    it('lets go of the traffic and the tree together', async () => {
      landed(message('a/one'));
      panel();

      await userEvent.click(screen.getByRole('button', { name: 'Clear the traffic' }));

      expect(useLogStore.getState().held).toBe(0);
      expect(useTopicTreeStore.getState().root.subTopics).toBe(0);
    });

    it('clears the record of what the link has done', async () => {
      useBrokerEventsStore.getState().push({ kind: 'ok', what: 'Connected' });
      panel();

      await userEvent.click(screen.getByRole('button', { name: 'Clear the events' }));

      expect(useBrokerEventsStore.getState().events).toEqual([]);
    });

    it('offers nothing to clear when it is holding nothing', () => {
      panel();

      expect(screen.getByRole('button', { name: 'Clear the traffic' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Clear the events' })).toBeDisabled();
    });
  });

  /*
   * The one thing on this screen that reaches past the console. A retained message is the
   * broker's: every other client sees it go, and nothing here can put it back — so it is asked
   * twice, and the second question names what is about to happen.
   */
  describe('what the broker is holding', () => {
    it('counts the topics whose newest message arrived retained', () => {
      landed(message('a/one', '1', true), message('b/two', '2', false), message('c/three', '3', true));

      panel();

      expect(screen.getByText('Retained').nextSibling).toHaveTextContent('2 topics');
    });

    // The emptying arrives back down the console's own subscription, and an empty retained
    // message is exactly what 'the broker is holding nothing' looks like on the wire.
    it('stops counting a topic whose retained message has been emptied', () => {
      landed(message('a/one', '1', true));
      landed(message('a/one', '', true));

      panel();

      expect(screen.getByText('Retained').nextSibling).toHaveTextContent('0 topics');
    });

    it('asks before it publishes anything', async () => {
      landed(message('a/one', '1', true));
      let sent = 0;
      server.use(
        http.post('/api/publish', () => {
          sent++;
          return new HttpResponse(null, { status: 202 });
        }),
      );
      panel();

      await userEvent.click(screen.getByRole('button', { name: 'Clear retained messages' }));

      expect(sent).toBe(0);
      expect(screen.getByText(/Every other client sees it too/)).toBeInTheDocument();
    });

    it('publishes an empty retained message to each of them when told to', async () => {
      landed(message('a/one', '1', true), message('c/three', '3', true));
      const sent: Array<Record<string, unknown>> = [];
      server.use(
        http.post('/api/publish', async ({ request }) => {
          sent.push((await request.json()) as Record<string, unknown>);
          return new HttpResponse(null, { status: 202 });
        }),
      );
      panel();

      await userEvent.click(screen.getByRole('button', { name: 'Clear retained messages' }));
      await userEvent.click(screen.getByRole('button', { name: 'Yes, clear 2' }));

      await waitFor(() => expect(sent).toHaveLength(2));
      expect(sent.map((one) => one.topic).sort()).toEqual(['a/one', 'c/three']);
      expect(sent[0]).toMatchObject({ payload: '', retain: true });
      expect(await screen.findByText(/Told the broker to forget 2 topics/)).toBeInTheDocument();
    });

    it('says how many the broker refused', async () => {
      landed(message('a/one', '1', true));
      server.use(http.post('/api/publish', () => new HttpResponse(null, { status: 403 })));
      panel();

      await userEvent.click(screen.getByRole('button', { name: 'Clear retained messages' }));
      await userEvent.click(screen.getByRole('button', { name: 'Yes, clear 1' }));

      expect(await screen.findByText(/the broker refused 1/)).toBeInTheDocument();
    });

    it('backs out when the reader cancels', async () => {
      landed(message('a/one', '1', true));
      panel();

      await userEvent.click(screen.getByRole('button', { name: 'Clear retained messages' }));
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(screen.getByRole('button', { name: 'Clear retained messages' })).toBeInTheDocument();
    });

    it('offers nothing when the broker is holding nothing retained', () => {
      landed(message('a/one', '1', false));
      panel();

      expect(screen.getByRole('button', { name: 'Clear retained messages' })).toBeDisabled();
    });
  });
});

/**
 * The retained figure is counted off this console's own tree, and that tree has a ceiling. A
 * broker holding more topics than it hands every one of them over and the quietest are dropped
 * as they arrive — so under a heading that says what the BROKER is holding, the figure is short
 * by however many were dropped, and the button beside it would clear only what it could see.
 */
describe('when the tree has given topics up to its ceiling', () => {
  it('says the retained figure is only what this console has seen', async () => {
    landed(message('plant/boiler/temp', '81', true));
    act(() => useTopicTreeStore.setState({ forgotten: 11_006 }));

    render(<ManagePanel onClose={() => {}} />);

    const note = await screen.findByTestId('retained-short');
    expect(note).toHaveTextContent(/what this console has seen/);
    expect(note).toHaveTextContent(/11,006 quiet topics/);
  });

  it('says nothing of the sort while the tree has kept everything', async () => {
    landed(message('plant/boiler/temp', '81', true));

    render(<ManagePanel onClose={() => {}} />);

    await screen.findByText('Retained');
    expect(screen.queryByTestId('retained-short')).not.toBeInTheDocument();
  });

  it('writes the counts with the separators the rest of the panel uses', async () => {
    const many = Array.from({ length: 1200 }, (_, i) => message(`t/${i}`, '1', true));
    landed(...many);

    render(<ManagePanel onClose={() => {}} />);

    expect(await screen.findByText('1,200 topics')).toBeInTheDocument();
  });
});
