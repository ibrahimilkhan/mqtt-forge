import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { createFakeHub } from './realtime/fakeHub';
import { server } from './test/server';
import { useAppearanceStore } from './stores/appearanceStore';
import { useBrokerEventsStore } from './stores/brokerEventsStore';
import { useLogStore } from './stores/logStore';
import { useSearchStore } from './stores/searchStore';
import { useSelectionStore } from './stores/selectionStore';
import { useTopicTreeStore } from './stores/topicTreeStore';
import { startApplyingAppearance } from './features/appearance/applyAppearance';
import { useHoldStore } from './features/monitor/useTraffic';
import type { MqttMessage } from './types/api';

/**
 * The console as somebody actually uses it, for the things a reader does to what it is holding.
 *
 * Every other test in these features holds one component still and asks it a question. These are
 * journeys through the whole app: find a topic among hundreds, read its run, pause two of them
 * and find them again an hour later, empty the console, tell the broker to forget what it is
 * keeping, and choose how much of the machine any of it may use.
 *
 * Nothing here writes into a store to arrange the screen. Messages arrive over the hub and
 * answers come from the server over MSW, because those are the only two ways the real console
 * ever learns anything.
 */

let frames: Array<() => void>;

beforeEach(() => {
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => frames.push(callback));
  vi.stubGlobal('cancelAnimationFrame', () => {});

  useLogStore.getState().clear();
  useTopicTreeStore.getState().reset();
  useTopicTreeStore.setState({ defaultOpen: true });
  useSelectionStore.getState().clear();
  useHoldStore.getState().release();
  useBrokerEventsStore.getState().clear();
  useSearchStore.getState().clear();
  useAppearanceStore.getState().reset();
  localStorage.clear();

  server.use(
    http.get('/api/connection', () =>
      HttpResponse.json({
        state: 'Connected',
        failure: null,
        connection: { host: 'plant.local', port: 1883, clientId: 'mqttforge-console' },
      }),
    ),
  );
});

afterEach(() => vi.unstubAllGlobals());

/** Runs frames until nothing more is booked: the queue hands over a frame's worth at a time. */
function runFrames(limit = 1000) {
  for (let ran = 0; frames.length > 0; ran++) {
    if (ran > limit) throw new Error('the queue never emptied');
    frames.shift()!();
  }
}

const message = (topic: string, payload: string, retain = false): MqttMessage => ({
  topic,
  payload,
  qos: 0,
  retain,
  receivedAt: '2026-09-06T10:00:00Z',
});

async function openConsole() {
  const hub = createFakeHub();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={queryClient}>
      <App hub={hub} />
    </QueryClientProvider>,
  );

  const send = (...sent: Array<[topic: string, payload: string, retain?: boolean]>) => {
    act(() =>
      hub.emit(
        'messagesReceived',
        sent.map(([topic, payload, retain]) => message(topic, payload, retain)),
      ),
    );
    act(() => runFrames());
  };

  // The console opens on the Broker panel and the Broker panel takes the whole window, link or
  // no link — so the tree is behind it until it is shut. Every journey below is about the tree,
  // so they all start where a reader starts: by closing the panel they have finished with.
  await userEvent.click(await screen.findByRole('button', { name: 'Close Broker panel' }));
  await screen.findByRole('heading', { name: 'Topics' });

  return { hub, send };
}

const menu = () => within(screen.getByRole('navigation', { name: 'Panels' }));

/** The Manage panel's Retained cell: its label, its figure and the word under them. */
const retained = (manage: ReturnType<typeof within>) =>
  manage.getByText('Retained').closest('div');

/**
 * Opens a panel from the rail, or leaves it open when it already is.
 *
 * The rail's buttons toggle, and the broker panel is the one the console opens on — so a plain
 * click on it is as likely to close the thing the test is about as to open it.
 */
const goTo = async (panel: string) => {
  if (screen.queryByRole('region', { name: `${panel} panel` }) === null) {
    // By prefix: the Broker row says what the link is doing as well as its name — 'Broker,
    // connected' — so an exact match finds every row but the one this console opens on.
    await userEvent.click(menu().getByRole('button', { name: new RegExp(`^${panel}`) }));
  }

  return within(await screen.findByRole('region', { name: `${panel} panel` }));
};

/** The panel column, whichever panel is in it. */
const panelNamed = (name: string) => within(screen.getByRole('region', { name }));

// The tree pane has no landmark of its own; its heading is off screen and names it. Scoped
// rather than queried globally because the log draws topic paths too, and every segment in one
// is text on the page as well.
const tree = () => screen.getByRole('heading', { name: 'Topics' }).closest('section')!;
const topics = () =>
  within(tree())
    .queryAllByTestId('segment')
    .slice(1)
    .map((one) => one.textContent);

const rowFor = (topic: string) =>
  within(tree())
    .getAllByTestId('segment')
    .find((one) => one.textContent === topic)!
    .closest<HTMLElement>('[data-testid="tree-row"]')!;

const pick = (topic: string) => userEvent.click(within(rowFor(topic)).getByTestId('segment'));
const pauseOn = (topic: string) =>
  userEvent.click(
    within(rowFor(topic)).getByRole('button', { name: /Pause the pane|Let the pane go/ }),
  );

const logRows = () => screen.queryAllByTestId('entry');

/** Every search in the console is behind a mark, and so is where it looks. */
const openFind = (label: string) => userEvent.click(screen.getByRole('button', { name: label }));
const lookIn = async (which: RegExp, option: string) => {
  await userEvent.click(screen.getByRole('button', { name: which }));
  await userEvent.click(screen.getByRole('menuitemradio', { name: option }));
};

// A plant: two branches, a topic that is quiet, and one carrying words rather than numbers.
const PLANT: Array<[string, string, boolean?]> = [
  ['plant/boiler/temp', '81'],
  ['plant/boiler/pressure', '2.1'],
  ['plant/boiler/state', 'burner on, degrees rising', true],
  ['plant/pump/temp', '19'],
  ['office/light', 'on', true],
  ['office/error/log', 'sensor fault'],
];

describe('finding one topic among many', () => {
  it('narrows the tree to what carries the words, and gives it back', async () => {
    const { send } = await openConsole();
    send(...PLANT);

    await openFind('Find a topic');
    await userEvent.type(screen.getByLabelText('Search the topics'), 'boiler');

    expect(topics()).toEqual([
      'plant/boiler',
      'plant/boiler/pressure',
      'plant/boiler/state',
      'plant/boiler/temp',
    ]);

    await userEvent.click(screen.getByRole('button', { name: 'Clear search the topics' }));

    expect(topics()).toEqual(expect.arrayContaining(['office', 'plant']));
  });

  it('finds a topic by what it is carrying when the reader looks there', async () => {
    const { send } = await openConsole();
    send(...PLANT);

    await openFind('Find a topic');
    await userEvent.type(screen.getByLabelText('Search the topics'), 'fault');
    await lookIn(/^Where to look in the topics/, 'Message');

    expect(topics()).toEqual(['office/error/log']);
  });

  // The whole journey: find it, read it, then find one line in its run.
  it('takes the reader from a search to one line of one topic', async () => {
    const { send } = await openConsole();
    send(...PLANT);
    send(['plant/boiler/state', 'burner off, cooling'], ['plant/boiler/state', 'burner on again']);

    await openFind('Find a topic');
    await userEvent.type(screen.getByLabelText('Search the topics'), 'state');
    await pick('plant/boiler/state');
    await userEvent.click(screen.getByRole('button', { name: /in history/ }));

    expect(logRows().length).toBeGreaterThan(1);

    await openFind('Find in the log');
    await userEvent.type(screen.getByLabelText('Search the log'), 'cooling');

    await waitFor(() => expect(logRows()).toHaveLength(1));
    expect(logRows()[0]).toHaveTextContent('burner off, cooling');
  });
});

describe('pausing more than one topic', () => {
  it('holds each at its own moment and lists them on the Manage screen', async () => {
    const { send } = await openConsole();
    send(...PLANT);

    await pick('temp');
    await pauseOn('temp');
    await pick('pressure');
    await pauseOn('pressure');

    send(['plant/boiler/temp', '99'], ['plant/boiler/pressure', '9.9']);

    // Both rows stand where they were put, while the traffic goes on behind them.
    expect(rowFor('temp')).toHaveTextContent('81');
    expect(rowFor('pressure')).toHaveTextContent('2.1');

    await goTo('Manage');
    const manage = panelNamed('Manage panel');

    expect(manage.getByRole('button', { name: 'plant/boiler/temp' })).toBeInTheDocument();
    expect(manage.getByRole('button', { name: 'plant/boiler/pressure' })).toBeInTheDocument();
    await waitFor(() => expect(manage.getAllByText(/1 behind/)).toHaveLength(2));
  });

  it('lets go of one from the Manage screen, and of the rest together', async () => {
    const { send } = await openConsole();
    send(...PLANT);
    await pick('temp');
    await pauseOn('temp');
    await pick('pressure');
    await pauseOn('pressure');

    await goTo('Manage');
    const manage = panelNamed('Manage panel');
    await userEvent.click(manage.getByRole('button', { name: 'Let go of plant/boiler/temp' }));

    expect([...useHoldStore.getState().held.keys()]).toEqual(['plant/boiler/pressure/#']);

    await pick('state');
    await pauseOn('state');
    await userEvent.click(manage.getByRole('button', { name: /Let go of all 2/ }));

    expect(useHoldStore.getState().held.size).toBe(0);
  });

  // Six paused topics on a broker with four thousand is exactly when a reader cannot find them.
  it('takes the reader back to a paused run by its name', async () => {
    const { send } = await openConsole();
    send(...PLANT);
    await pick('temp');
    await pauseOn('temp');
    await pick('light');

    await goTo('Manage');
    await userEvent.click(
      panelNamed('Manage panel').getByRole('button', { name: 'plant/boiler/temp' }),
    );

    expect(useSelectionStore.getState().selected?.filter).toBe('plant/boiler/temp/#');
  });
});

describe('emptying the console', () => {
  it('lets go of the traffic and the tree together, from the Manage screen', async () => {
    const { send } = await openConsole();
    send(...PLANT);
    await pick('temp');

    await goTo('Manage');
    await userEvent.click(panelNamed('Manage panel').getByRole('button', { name: 'Clear traffic' }));
    await userEvent.click(panelNamed('Manage panel').getByRole('button', { name: /^Yes, clear/ }));

    expect(useLogStore.getState().held).toBe(0);
    expect(within(tree()).getByText(/No topics yet/)).toBeInTheDocument();
  });

  /**
   * The log pane's own Clear answers for the pane, and the pane is one selection.
   *
   * It used to call the same thing the Manage screen does, so emptying the pane on one topic took
   * the tree with it: every other topic on the broker, every branch the reader had opened, gone
   * because they wanted one run out of the way.
   */
  it('takes the selection it is standing over, and leaves the rest of the tree', async () => {
    const { send } = await openConsole();
    send(...PLANT);
    await pick('temp');
    await openFind('Find in the log');
    await userEvent.type(screen.getByLabelText('Search the log'), 'zzz');

    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await userEvent.click(screen.getByRole('button', { name: /^Clear \d/ }));

    // PLANT is six messages on six topics; one of them was selected and is gone.
    expect(useLogStore.getState().held).toBe(5);
    expect(within(tree()).queryByText(/No topics yet/)).not.toBeInTheDocument();
    expect(within(tree()).getByText('pump')).toBeInTheDocument();
    expect(screen.getByLabelText('Search the log')).toHaveValue('');
  });

  // The pane cleared with the reading left on it, which is the other half of what a reader means.
  it('can leave the newest message standing', async () => {
    const { send } = await openConsole();
    send(...PLANT);
    send(['plant/boiler/temp', '82'], ['plant/boiler/temp', '83']);
    await pick('temp');

    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await userEvent.click(screen.getByRole('button', { name: 'Keep newest' }));

    // The run is one message deep and it is the newest; everything else is untouched.
    const kept = useLogStore.getState().byTopic.get('plant/boiler/temp');
    expect(kept?.length).toBe(1);
    expect(kept?.newestFirst()[0].body).toBe('83');
    expect(useLogStore.getState().held).toBe(6);
  });
});

describe('telling the broker to forget what it is holding', () => {
  it('counts what arrived retained, asks, and then publishes an empty message to each', async () => {
    const sent: Array<Record<string, unknown>> = [];
    server.use(
      http.post('/api/publish', async ({ request }) => {
        sent.push((await request.json()) as Record<string, unknown>);
        return new HttpResponse(null, { status: 202 });
      }),
    );
    const { send } = await openConsole();
    send(...PLANT);

    await goTo('Manage');
    const manage = panelNamed('Manage panel');
    // The cell is a label, a figure and the word under it — three elements, so the number is
    // asserted on its own rather than as a sentence the DOM never writes.
    await waitFor(() => expect(retained(manage)).toHaveTextContent('2'));
    expect(retained(manage)).toHaveTextContent('topics');

    await userEvent.click(manage.getByRole('button', { name: 'Clear retained' }));
    expect(sent).toHaveLength(0);
    expect(manage.getByText(/Every other client sees it too/)).toBeInTheDocument();

    await userEvent.click(manage.getByRole('button', { name: 'Yes, clear 2' }));

    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent.map((one) => one.topic).sort()).toEqual(['office/light', 'plant/boiler/state']);
    expect(sent.every((one) => one.payload === '' && one.retain === true)).toBe(true);
  });

  // Mosquitto publishes every one of its statistics retained, so a console that has ticked
  // Subscribe $SYS counted them among what the broker is holding and offered to clear them. A
  // client may not publish under `$`: the empty messages went nowhere, the broker republished the
  // lot ten seconds later, and the figure sat where it was under a sentence saying it had been
  // emptied.
  it('leaves the broker\'s own tree out of what it offers to clear', async () => {
    const { send } = await openConsole();
    send(...PLANT, ['$SYS/broker/clients/connected', '3', true], ['$SYS/broker/uptime', '90 seconds', true]);

    await goTo('Manage');
    const manage = panelNamed('Manage panel');

    await waitFor(() => expect(retained(manage)).toHaveTextContent('2'));
    expect(manage.getByRole('button', { name: 'Clear retained' })).toBeEnabled();
  });

  // The emptying comes back down the console's own subscription, and that is what puts the
  // count right — the figure says what the broker is holding as far as this console was told.
  it('stops counting the topics once the emptying arrives back', async () => {
    server.use(http.post('/api/publish', () => new HttpResponse(null, { status: 202 })));
    const { send } = await openConsole();
    send(...PLANT);

    await goTo('Manage');
    const manage = panelNamed('Manage panel');
    await userEvent.click(manage.getByRole('button', { name: 'Clear retained' }));
    await userEvent.click(manage.getByRole('button', { name: 'Yes, clear 2' }));

    send(['office/light', '', true], ['plant/boiler/state', '', true]);

    await waitFor(() => expect(retained(manage)).toHaveTextContent('0'), { timeout: 3000 });
  });
});

describe('the record of what the link has done', () => {
  it('counts it, narrows it, and empties it', async () => {
    await openConsole();
    act(() => {
      useBrokerEventsStore.getState().push({ kind: 'ok', what: 'Connected' });
      useBrokerEventsStore.getState().push({ kind: 'fault', what: 'Link dropped', detail: 'reset' });
      useBrokerEventsStore.getState().push({ kind: 'ok', what: 'Subscribed', detail: '#' });
    });

    await goTo('Broker');
    const broker = panelNamed('Broker panel');
    expect(broker.getByRole('heading', { name: /^Events/ })).toHaveTextContent('(3)');

    await userEvent.click(broker.getByRole('button', { name: 'Find in the record' }));
    await userEvent.type(broker.getByLabelText('Search broker events'), 'dropped');

    expect(broker.getByRole('heading', { name: /^Events/ })).toHaveTextContent('(1 of 3)');
    expect(broker.getAllByRole('listitem')).toHaveLength(1);

    await userEvent.click(broker.getByRole('button', { name: 'Clear the broker events' }));

    expect(broker.getByText('Nothing has happened yet.')).toBeInTheDocument();
    expect(broker.getByLabelText('Search broker events')).toHaveValue('');
  });
});

describe('choosing how much of the machine the console may use', () => {
  it('takes the answer the reader gives and holds the traffic to it', async () => {
    // What main.tsx starts before the first render: the stored choices reaching the things they
    // are about. Without it the panel would write the answer down and nothing would read it.
    const stop = startApplyingAppearance();
    await openConsole();

    const settings = await goTo('Settings');
    await userEvent.selectOptions(settings.getByLabelText('Memory for held messages'), '100');

    expect(useLogStore.getState().budget).toBe(100 * 1024 * 1024);

    const manage = await goTo('Manage');
    expect(manage.getByText('Payload').closest('div')).toHaveTextContent('of 100 MB');
    stop();
  });

  it('keeps every message while there is room for it', async () => {
    const { send } = await openConsole();
    const heavy = 'x'.repeat(300 * 1024);

    send(['plant/dump', heavy], ['plant/dump', heavy], ['plant/dump', heavy]);

    // Three quarters of a megabyte on one topic, and none of it thrown away: the per-topic
    // ceiling is not spent until the console as a whole is full.
    expect(useLogStore.getState().byTopic.get('plant/dump')!.length).toBe(3);
    expect(useLogStore.getState().capped).toBe(false);
  });
});
