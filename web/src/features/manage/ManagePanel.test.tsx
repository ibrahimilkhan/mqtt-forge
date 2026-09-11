import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { server } from '../../test/server';
import type { DecodedMessage } from '../../realtime/decodeIncoming';
import { useBrokerEventsStore } from '../../stores/brokerEventsStore';
import { useHealthStore } from '../../stores/healthStore';
import { useLogStore } from '../../stores/logStore';
import { usePauseStore } from '../../stores/pauseStore';
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
/** One figure cell: its label, its number and whatever word stands under them. */
const figure = (label: string) => screen.getByText(label).closest('div');

const pause = (path: string) =>
  useHoldStore
    .getState()
    .hold(
      `${path}/#`,
      useLogStore.getState().byTopic.get(path)?.newestFirst() ?? [],
      new Map(),
    );

beforeEach(() => {
  // Module singletons: a figure left over from one test is a figure the next one reports.
  useHealthStore.setState({ dropped: 0 });
  usePauseStore.setState({ lost: 0 });
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

      expect(figure('Messages')).toHaveTextContent('2');
      expect(figure('Topics')).toHaveTextContent('2');
      // Two elements, so two assertions: the figure is the figure and the ceiling is the note
      // under it, which is what keeps a number a number.
      expect(figure('Payload')).toHaveTextContent('2 kB');
      expect(figure('Payload')).toHaveTextContent('of 500 MB');
      expect(figure('Broker events')).toHaveTextContent('1');
    });

    it('lets go of the traffic and the tree together', async () => {
      landed(message('a/one'));
      panel();

      await userEvent.click(screen.getByRole('button', { name: 'Clear traffic' }));
      await userEvent.click(screen.getByRole('button', { name: /^Yes, clear/ }));

      expect(useLogStore.getState().held).toBe(0);
      expect(useTopicTreeStore.getState().root.subTopics).toBe(0);
    });

    // A session's worth of what the console has seen, and the broker cannot give it back.
    it('asks before it empties either of them, and takes Cancel for an answer', async () => {
      landed(message('a/one'));
      panel();

      await userEvent.click(screen.getByRole('button', { name: 'Clear traffic' }));

      expect(useLogStore.getState().held).toBe(1);
      expect(screen.getByText(/Nothing here can put them back/)).toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(useLogStore.getState().held).toBe(1);
      expect(screen.getByRole('button', { name: 'Clear traffic' })).toBeInTheDocument();
    });

    it('clears the record of what the link has done', async () => {
      useBrokerEventsStore.getState().push({ kind: 'ok', what: 'Connected' });
      panel();

      await userEvent.click(screen.getByRole('button', { name: 'Clear events' }));
      await userEvent.click(screen.getByRole('button', { name: /^Yes, clear/ }));

      expect(useBrokerEventsStore.getState().events).toEqual([]);
    });

    it('offers nothing to clear when it is holding nothing', () => {
      panel();

      expect(screen.getByRole('button', { name: 'Clear traffic' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Clear events' })).toBeDisabled();
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

      expect(figure('Retained')).toHaveTextContent('2');
      expect(figure('Retained')).toHaveTextContent('topics');
    });

    // The emptying arrives back down the console's own subscription, and an empty retained
    // message is exactly what 'the broker is holding nothing' looks like on the wire.
    it('stops counting a topic whose retained message has been emptied', () => {
      landed(message('a/one', '1', true));
      landed(message('a/one', '', true));

      panel();

      expect(figure('Retained')).toHaveTextContent('0');
      expect(figure('Retained')).toHaveTextContent('topics');
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

      await userEvent.click(screen.getByRole('button', { name: 'Clear retained' }));

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

      await userEvent.click(screen.getByRole('button', { name: 'Clear retained' }));
      await userEvent.click(screen.getByRole('button', { name: 'Yes, clear 2 topics' }));

      await waitFor(() => expect(sent).toHaveLength(2));
      expect(sent.map((one) => one.topic).sort()).toEqual(['a/one', 'c/three']);
      expect(sent[0]).toMatchObject({ payload: '', retain: true });
      expect(await screen.findByText(/Told the broker to forget 2 topics/)).toBeInTheDocument();
    });

    it('says how many the broker refused', async () => {
      landed(message('a/one', '1', true));
      server.use(http.post('/api/publish', () => new HttpResponse(null, { status: 403 })));
      panel();

      await userEvent.click(screen.getByRole('button', { name: 'Clear retained' }));
      await userEvent.click(screen.getByRole('button', { name: 'Yes, clear 1 topic' }));

      // Not 'Forgot 0; the broker refused 1', which is a strange way to say nothing happened —
      // and this is the ordinary answer from a broker that does not let this client publish.
      expect(await screen.findByText('The broker refused the topic.')).toBeInTheDocument();
    });

    it('says how many it let go and how many it kept when it is some of each', async () => {
      landed(message('a/one', '1', true), message('a/two', '2', true));
      let seen = 0;
      server.use(
        http.post('/api/publish', () =>
          (seen += 1) === 1 ? HttpResponse.json({}) : new HttpResponse(null, { status: 403 }),
        ),
      );
      panel();

      await userEvent.click(screen.getByRole('button', { name: 'Clear retained' }));
      await userEvent.click(screen.getByRole('button', { name: 'Yes, clear 2 topics' }));

      expect(await screen.findByText('Forgot 1; the broker refused 1.')).toBeInTheDocument();
    });

    it('backs out when the reader cancels', async () => {
      landed(message('a/one', '1', true));
      panel();

      await userEvent.click(screen.getByRole('button', { name: 'Clear retained' }));
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(screen.getByRole('button', { name: 'Clear retained' })).toBeInTheDocument();
    });

    it('offers nothing when the broker is holding nothing retained', () => {
      landed(message('a/one', '1', false));
      panel();

      expect(screen.getByRole('button', { name: 'Clear retained' })).toBeDisabled();
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

    await waitFor(() => expect(figure('Topics')).toHaveTextContent('1,200'));
  });
});

/**
 * The two figures the panel could not say.
 *
 * 'Am I seeing everything' is the question a monitoring console is opened with, and the answers
 * lived in two other places: the tree's foot counted what its ceiling had forgotten, and the log
 * wrote a line when the server's queue dropped something. Neither is where a reader looks for a
 * figure, and a zero in each is the reassurance they came for.
 */
describe('what never reached the console', () => {
  it('counts the topics the tree gave up to its ceiling', async () => {
    landed(message('a/one'));
    act(() => useTopicTreeStore.setState({ forgotten: 11_006 }));

    render(<ManagePanel onClose={() => {}} />);

    expect(figure('Topics')).toHaveTextContent('11,006 forgotten to the ceiling');
  });

  it('counts what the server dropped and what the queue let go, together', async () => {
    landed(message('a/one'));
    act(() => {
      useHealthStore.setState({ dropped: 1_200 });
      usePauseStore.getState().lose(40);
    });

    render(<ManagePanel onClose={() => {}} />);

    expect(figure('Dropped')).toHaveTextContent('1,240');
    expect(figure('Dropped')).toHaveTextContent('never reached the log');
  });

  it('says nothing under a zero, because nothing is what it means', async () => {
    landed(message('a/one'));

    render(<ManagePanel onClose={() => {}} />);

    expect(figure('Dropped')).toHaveTextContent('0');
    expect(figure('Dropped')).not.toHaveTextContent('never reached');
    expect(figure('Topics')).not.toHaveTextContent('forgotten');
  });
});
