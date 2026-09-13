import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamPause } from './features/monitor/StreamPause';
import { TrafficPane } from './features/monitor/TrafficPane';
import { useHoldStore } from './stores/holdStore';
import { clearSelection } from './stores/clearTraffic';
import { WireLog } from './features/monitor/WireLog';
import { TopicTree } from './features/topics/TopicTree';
import { createFakeHub } from './realtime/fakeHub';
import { useHubBridge } from './realtime/useHubBridge';
import { useLogStore } from './stores/logStore';
import { usePauseStore } from './stores/pauseStore';
import { useSelectionStore } from './stores/selectionStore';
import { useTopicTreeStore } from './stores/topicTreeStore';
import type { MqttMessage } from './types/api';

/**
 * The two pauses, together.
 *
 * There are two, they are different, and the difference is the whole reason both exist. The one
 * in the rail stops the console taking messages in at all: nothing reaches the log, the tree or
 * the chart, and what arrives is queued behind it. The one on a topic row stops that row and the
 * run it stands for: the broker carries on, every other row carries on counting, and only what
 * the reader is reading holds still.
 *
 * Each has its own tests. These are about the pair — one on top of the other, and both against a
 * link that comes and goes — because that is where the two can contradict each other, and where
 * a reader can be shown a console that is lying about what it is doing.
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
  usePauseStore.setState({ paused: false, waiting: 0, lost: 0 });
});

afterEach(() => vi.unstubAllGlobals());

/**
 * Runs frames until nothing more is scheduled. The queue hands over a frame's worth at a time
 * and books the next frame itself, so one pass is not the whole drain.
 */
function runFrames(limit = 1000) {
  for (let ran = 0; frames.length > 0; ran++) {
    if (ran > limit) throw new Error('the queue never emptied');
    frames.shift()!();
  }
}

const message = (topic: string, payload: string): MqttMessage => ({
  topic,
  payload,
  qos: 0,
  retain: false,
  receivedAt: '2026-08-23T10:00:00Z',
});

/**
 * The console's four moving parts: the control that stops it taking messages, the tree that
 * carries the control that stops one row, and the two panes that read the selected run.
 *
 * The hub bridge is mounted for real, so a message takes the path it takes in the app — over the
 * hub, through the queue, into the stores — rather than being written into a store by hand.
 */
function Console({ hub, live = true }: { hub: ReturnType<typeof createFakeHub>; live?: boolean }) {
  useHubBridge(hub);

  return (
    <>
      <StreamPause live={live} />
      {/* Wrapped so a query can be scoped to the tree: the log draws topic paths too, and every
          segment in one is text on the page as well. */}
      <section data-testid="tree">
        <TopicTree broker="localhost:1883" />
      </section>
      <WireLog />
      <TrafficPane />
    </>
  );
}

function renderConsole({ live = true }: { live?: boolean } = {}) {
  const hub = createFakeHub();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={queryClient}>
      <Console hub={hub} live={live} />
    </QueryClientProvider>,
  );

  /** Sends over the hub and lets every frame the queue books run. */
  const send = (...sent: Array<[topic: string, payload: string]>) => {
    act(() => hub.emit('messagesReceived', sent.map(([topic, payload]) => message(topic, payload))));
    act(() => runFrames());
  };

  return { hub, send };
}

const tree = () => within(screen.getByTestId('tree'));

const rowOf = (segment: string) =>
  tree().getByText(segment).closest<HTMLElement>('[data-testid="tree-row"]')!;

/** The row for a segment, or null when the tree is not drawing one. */
const rowFor = (segment: string) => tree().queryByText(segment);

/** Picking a row is what puts its run in the panes and its hold control on the row. */
const pick = (segment: string) => userEvent.click(tree().getByText(segment));

/** The control in the rail. */
const streamControl = () =>
  screen.getByRole('button', { name: /Stop stream|Resume/ });

/** The control on the selected row, if that row is carrying one. */
const holdControl = () => screen.getByRole('button', { name: /Pause the pane|Let the pane go/ });

/** The control on one particular row — every paused row carries one, not only the selected. */
const holdOn = (segment: string) =>
  within(rowOf(segment)).getByRole('button', { name: /Pause the pane|Let the pane go/ });

/** What the chart says it is drawing, which is the third pane a hold has to reach. */
const onChart = () => screen.getByTestId('reading-n').textContent;

// ---- the console-wide stop, over every pane at once ----

describe('the stop in the rail', () => {
  it('holds the tree, the entries and the chart together', async () => {
    const { send } = renderConsole();
    send(['sensors/temp', '21'], ['sensors/temp', '22'], ['sensors/humidity', '55']);
    await pick('temp');

    expect(rowOf('temp')).toHaveTextContent('22');
    expect(onChart()).toBe('2');

    await userEvent.click(streamControl());
    send(['sensors/temp', '99'], ['sensors/pressure', '1013']);

    // Every pane, and the tree with them: nothing arrived anywhere.
    expect(rowOf('temp')).toHaveTextContent('22');
    expect(rowFor('pressure')).toBeNull();
    expect(screen.getByTestId('body')).toHaveTextContent('22');
    expect(onChart()).toBe('2');
  });

  it('says how many are waiting behind it, and lands every one of them on resume', async () => {
    const { send } = renderConsole();
    send(['sensors/temp', '21']);
    await pick('temp');
    await userEvent.click(streamControl());

    send(['sensors/temp', '22'], ['sensors/temp', '23'], ['sensors/pressure', '1013']);

    expect(usePauseStore.getState().waiting).toBe(3);
    expect(useLogStore.getState().held).toBe(1);

    await act(async () => {
      await userEvent.click(streamControl());
    });
    act(() => runFrames());

    expect(useLogStore.getState().held).toBe(4);
    expect(rowOf('temp')).toHaveTextContent('23');
    expect(rowFor('pressure')).not.toBeNull();
    expect(usePauseStore.getState().waiting).toBe(0);
    expect(usePauseStore.getState().lost).toBe(0);
  });
});

// ---- the stop on one row, which is a different promise ----

describe('the hold on a topic row', () => {
  it('stops the row it is on, and leaves every other row counting', async () => {
    const { send } = renderConsole();
    send(['sensors/temp', '21'], ['sensors/humidity', '55']);
    await pick('temp');
    await userEvent.click(holdControl());

    send(['sensors/temp', '99'], ['sensors/humidity', '56']);

    // The reader pressed pause on this row: its value is what it was when they pressed it.
    expect(rowOf('temp')).toHaveTextContent('21');
    // And the rest of the tree is not what they paused.
    expect(rowOf('humidity')).toHaveTextContent('56');
    // The traffic did reach the console — this pause is not the rail's.
    expect(useLogStore.getState().held).toBe(4);
    expect(usePauseStore.getState().waiting).toBe(0);
  });

  it('stops the entries and the chart reading that row', async () => {
    const { send } = renderConsole();
    send(['sensors/temp', '21'], ['sensors/temp', '22']);
    await pick('temp');
    await userEvent.click(holdControl());

    send(['sensors/temp', '99']);

    expect(screen.getByTestId('body')).toHaveTextContent('22');
    expect(onChart()).toBe('2');
    expect(holdControl()).toHaveAccessibleName('Let the pane go, 1 arrived while it was paused');
  });

  it('holds a branch and everything under it', async () => {
    const { send } = renderConsole();
    send(['sensors/temp', '21'], ['plant/kiln', '900']);
    await pick('sensors');
    await userEvent.click(holdControl());

    send(['sensors/temp', '99'], ['plant/kiln', '910']);

    expect(rowOf('temp')).toHaveTextContent('21');
    // The branch's own summary is a count of what is under it, and it stops with the rows.
    expect(rowOf('sensors')).toHaveTextContent('1 topic · 1 message');
    expect(rowOf('kiln')).toHaveTextContent('910');
  });

  // A branch counts everything under it, so an ancestor of a held row went on counting messages
  // the reader had just asked it to stop showing — the tree said one number and the rows under
  // it added up to another.
  it('keeps what it is holding out of the counts on the rows above it', async () => {
    const { send } = renderConsole();
    send(['sensors/temp', '21'], ['sensors/humidity', '55']);
    await pick('temp');

    expect(rowOf('sensors')).toHaveTextContent('2 topics · 2 messages');

    await userEvent.click(holdControl());
    send(['sensors/temp', '99'], ['sensors/temp', '98']);

    // Two arrived, both behind the hold: the branch above says what its rows still add up to.
    expect(rowOf('sensors')).toHaveTextContent('2 topics · 2 messages');
    // And so does the broker's row, which is above every topic there is.
    expect(rowOf('localhost:1883')).toHaveTextContent('2 topics · 2 messages');
  });

  it('goes on counting what the hold is not holding', async () => {
    const { send } = renderConsole();
    send(['sensors/temp', '21'], ['sensors/humidity', '55']);
    await pick('temp');
    await userEvent.click(holdControl());

    send(['sensors/temp', '99'], ['sensors/humidity', '56'], ['plant/kiln', '900']);

    // One of the three was held; the other two are the branch's own business.
    expect(rowOf('sensors')).toHaveTextContent('2 topics · 3 messages');
    expect(rowOf('localhost:1883')).toHaveTextContent('3 topics · 4 messages');
  });

  it('counts a topic that arrived behind the hold only once it is let go', async () => {
    const { send } = renderConsole();
    send(['sensors/temp', '21']);
    await pick('sensors');
    await userEvent.click(holdControl());

    send(['sensors/pressure', '1013']);

    // Not drawn, and not counted above either — the two would otherwise disagree.
    expect(rowFor('pressure')).toBeNull();
    expect(rowOf('localhost:1883')).toHaveTextContent('1 topic · 1 message');

    await userEvent.click(holdControl());

    expect(rowFor('pressure')).not.toBeNull();
    expect(rowOf('localhost:1883')).toHaveTextContent('2 topics · 2 messages');
  });

  it('does not draw a topic that arrives behind the hold', async () => {
    const { send } = renderConsole();
    send(['sensors/temp', '21']);
    await pick('sensors');
    await userEvent.click(holdControl());

    send(['sensors/pressure', '1013']);

    // The rows stop where they are, and one appearing is not standing still.
    expect(rowFor('pressure')).toBeNull();

    await userEvent.click(holdControl());

    expect(rowFor('pressure')).not.toBeNull();
  });

  it('catches the row up when it is let go', async () => {
    const { send } = renderConsole();
    send(['sensors/temp', '21']);
    await pick('temp');
    await userEvent.click(holdControl());
    send(['sensors/temp', '99']);

    await userEvent.click(holdControl());

    expect(rowOf('temp')).toHaveTextContent('99');
    expect(screen.getByTestId('body')).toHaveTextContent('99');
  });

  /*
   * It used to let go here, on the argument that a hold is over the run in front of the reader
   * and picking another row puts a different run there. That was the wrong reading of what a
   * hold is about: it is about a topic, not about the pane, and the reader who goes to look at
   * something else is exactly the reader who wants to come back to the reading they stopped.
   */
  it('keeps its hold when another row is picked, and is still holding it on the way back', async () => {
    const { send } = renderConsole();
    send(['sensors/temp', '21'], ['sensors/humidity', '55']);
    await pick('temp');
    await userEvent.click(holdControl());

    await pick('humidity');
    send(['sensors/temp', '99']);

    // The row stays where it was put, wherever the reader has gone since.
    expect(rowOf('temp')).toHaveTextContent('21');
    expect(useHoldStore.getState().held.size).toBe(1);

    await pick('temp');
    expect(screen.getByTestId('body')).toHaveTextContent('21');
  });

  it('holds two topics at once, each at its own moment', async () => {
    const { send } = renderConsole();
    send(['sensors/temp', '21'], ['sensors/humidity', '55']);

    await pick('temp');
    await userEvent.click(holdOn('temp'));
    await pick('humidity');
    await userEvent.click(holdOn('humidity'));

    send(['sensors/temp', '99'], ['sensors/humidity', '80']);

    expect(useHoldStore.getState().held.size).toBe(2);
    expect(rowOf('temp')).toHaveTextContent('21');
    expect(rowOf('humidity')).toHaveTextContent('55');
  });

  // A hold with nothing on screen to undo it is a trap. The row wears its own control wherever
  // the reader has gone since, so the one they paused an hour ago is the one they can let go.
  it('carries its own control on a row that is not the selected one', async () => {
    const { send } = renderConsole();
    send(['sensors/temp', '21'], ['sensors/humidity', '55']);
    await pick('temp');
    await userEvent.click(holdControl());

    await pick('humidity');

    // Two now: the paused row's, and the selected row's own.
    const controls = screen.getAllByRole('button', { name: /Pause the pane|Let the pane go/ });
    expect(controls).toHaveLength(2);

    await userEvent.click(screen.getByRole('button', { name: /Let the pane go/ }));
    expect(useHoldStore.getState().held.size).toBe(0);
  });
});

// ---- one on top of the other ----

describe('both pauses at once', () => {
  it('holds a row inside a stopped console, and neither undoes the other', async () => {
    const { send } = renderConsole();
    send(['sensors/temp', '21'], ['sensors/humidity', '55']);
    await pick('temp');

    await userEvent.click(holdControl());
    await userEvent.click(streamControl());
    send(['sensors/temp', '99'], ['sensors/humidity', '56']);

    // The rail queued them, so not even the rows the hold does not cover moved.
    expect(rowOf('temp')).toHaveTextContent('21');
    expect(rowOf('humidity')).toHaveTextContent('55');
    expect(usePauseStore.getState().waiting).toBe(2);
  });

  it('lands the queue on the rows the hold does not cover, and holds the ones it does', async () => {
    const { send } = renderConsole();
    send(['sensors/temp', '21'], ['sensors/humidity', '55']);
    await pick('temp');
    await userEvent.click(holdControl());
    await userEvent.click(streamControl());
    send(['sensors/temp', '99'], ['sensors/humidity', '56']);

    // The rail lets go first: the queue lands, and the held row is still held.
    await act(async () => {
      await userEvent.click(streamControl());
    });
    act(() => runFrames());

    expect(rowOf('humidity')).toHaveTextContent('56');
    expect(rowOf('temp')).toHaveTextContent('21');
    expect(useLogStore.getState().held).toBe(4);

    // Then the row: it catches up on what landed while it was held.
    await userEvent.click(holdControl());

    expect(rowOf('temp')).toHaveTextContent('99');
  });

  it('counts nothing as waiting while only a row is held', async () => {
    const { send } = renderConsole();
    send(['sensors/temp', '21']);
    await pick('temp');
    await userEvent.click(holdControl());

    send(['sensors/temp', '99']);

    // A held row is not a queue: the messages were taken in, they are simply not drawn here.
    expect(usePauseStore.getState().waiting).toBe(0);
    expect(streamControl()).toHaveAccessibleName('Stop stream');
  });

  it('leaves a held row held when the console is stopped and started again', async () => {
    const { send } = renderConsole();
    send(['sensors/temp', '21']);
    await pick('temp');
    await userEvent.click(holdControl());

    await userEvent.click(streamControl());
    await act(async () => {
      await userEvent.click(streamControl());
    });
    act(() => runFrames());

    expect(useHoldStore.getState().held).not.toBeNull();
    expect(holdControl()).toHaveAccessibleName(/Let the pane go/);
  });

  it('does not bring back on resume a topic cleared while the console was stopped', async () => {
    const { send } = renderConsole();
    send(['sensors/temp', '21'], ['sensors/humidity', '55']);
    await userEvent.click(streamControl());
    send(['sensors/temp', '99'], ['sensors/humidity', '56']);

    act(() => clearSelection('sensors/temp/#', 'nothing'));

    expect(usePauseStore.getState().waiting).toBe(1);

    await act(async () => {
      await userEvent.click(streamControl());
    });
    act(() => runFrames());

    expect(rowFor('temp')).toBeNull();
    expect(rowOf('humidity')).toHaveTextContent('56');
    expect(usePauseStore.getState().lost).toBe(0);
  });
});

// ---- and against a link that comes and goes ----

describe('the two pauses against the link', () => {
  it('puts the rail control out of reach with no broker, and leaves the row control working', async () => {
    const { send } = renderConsole({ live: false });
    send(['sensors/temp', '21']);
    await pick('temp');

    // Nothing is arriving, so there is nothing to stop.
    expect(screen.getByRole('button', { name: 'Stop stream' })).toBeDisabled();
    // The row's hold is about what is drawn, not about the link, so it is offered either way.
    await userEvent.click(holdControl());
    expect(useHoldStore.getState().held).not.toBeNull();
  });

  it('keeps the way back when the broker drops while the console is stopped', async () => {
    const { send } = renderConsole();
    send(['sensors/temp', '21']);
    await pick('temp');
    await userEvent.click(streamControl());
    send(['sensors/temp', '22'], ['sensors/temp', '23']);

    // The link goes while it is stopped. The control has to stay reachable: it is the only way
    // back, and a console left holding a queue nobody can release would ignore the traffic when
    // the link returned.
    render(<StreamPause live={false} />);
    const [, offline] = screen.getAllByRole('button', { name: /Resume/ });

    expect(offline).toBeEnabled();

    await act(async () => {
      await userEvent.click(offline);
    });
    act(() => runFrames());

    expect(useLogStore.getState().held).toBe(3);
    expect(rowOf('temp')).toHaveTextContent('23');
  });

  it('lets go of the queue and the hold when a connection starts the tree again', async () => {
    const { send } = renderConsole();
    send(['sensors/temp', '21']);
    await pick('temp');
    await userEvent.click(holdControl());
    await userEvent.click(streamControl());
    send(['sensors/temp', '22'], ['sensors/temp', '23']);

    expect(usePauseStore.getState().waiting).toBe(2);

    // What connecting does. The queue was meant for the tree that has just gone, and so was the
    // hold: both are about a session that is no longer on screen.
    act(() => useTopicTreeStore.getState().reset());

    expect(usePauseStore.getState().waiting).toBe(0);
    expect(usePauseStore.getState().lost).toBe(2);
    expect(useHoldStore.getState().held.size).toBe(0);

    // And the new session fills the new tree, with nothing of the old one written over it.
    await act(async () => {
      await userEvent.click(streamControl());
    });
    send(['sensors/temp', '30']);

    expect(rowOf('temp')).toHaveTextContent('30');
  });

  it('goes on holding a row while the hub is away, since a hold is not about the link', async () => {
    const { hub, send } = renderConsole();
    send(['sensors/temp', '21']);
    await pick('temp');
    await userEvent.click(holdControl());

    act(() => hub.emit('reconnecting'));
    act(() => hub.emit('reconnected'));
    send(['sensors/temp', '99']);

    expect(useHoldStore.getState().held).not.toBeNull();
    expect(rowOf('temp')).toHaveTextContent('21');

    await userEvent.click(holdControl());

    expect(rowOf('temp')).toHaveTextContent('99');
  });
});

// ---- a hold seen from the rows around it ----

describe('a hold seen from the rows around it', () => {
  // The report: every mqtt.hsl.fi topic hangs off the empty first level, the reader paused it,
  // picked the broker's row above it, and watched the log stream on.
  it('keeps the broker row still when / is paused and the broker row is picked', async () => {
    const { send } = renderConsole();
    send(['/hfp/bus/one', 'a1'], ['/hfp/bus/two', 'b1']);
    await pick('/');
    await userEvent.click(holdOn('/'));
    send(['/hfp/bus/one', 'a2']);

    await pick('localhost:1883');

    expect(screen.getByTestId('body')).toHaveTextContent('b1');
    expect(rowOf('localhost:1883')).toHaveTextContent('2 topics · 2 messages');
  });

  it("shows a row under a paused branch its own reading, not its sibling's", async () => {
    const { send } = renderConsole();
    send(['sensors/temp', '21'], ['sensors/humidity', '55']);
    await pick('sensors');
    await userEvent.click(holdControl());
    send(['sensors/temp', '22']);

    await pick('temp');

    expect(screen.getByTestId('body')).toHaveTextContent('21');
  });

  it('offers a row under a paused branch a hold of its own, taken from what is on screen', async () => {
    const { send } = renderConsole();
    send(['sensors/temp', '21'], ['sensors/humidity', '55']);
    await pick('sensors');
    await userEvent.click(holdControl());
    send(['sensors/temp', '22']);
    await pick('temp');

    const own = within(rowOf('temp')).getByRole('button', { name: 'Pause the pane on its own' });
    expect(own).toHaveAttribute(
      'title',
      'Paused with sensors — pause it on its own to keep it paused when sensors is let go',
    );

    await userEvent.click(own);

    // Taken from the frozen view: nothing on screen moved.
    expect(rowOf('temp')).toHaveTextContent('21');
    expect(screen.getByTestId('body')).toHaveTextContent('21');

    // And it outlives the branch it was taken under.
    await userEvent.click(within(rowOf('sensors')).getByRole('button', { name: /Let the pane go/ }));

    expect(rowOf('temp')).toHaveTextContent('21');
    expect(rowOf('humidity')).toHaveTextContent('55');
  });

  it("keeps the broker row's control on it after another row is picked", async () => {
    const { send } = renderConsole();
    send(['sensors/temp', '21']);
    await pick('localhost:1883');
    await userEvent.click(holdOn('localhost:1883'));

    await pick('temp');

    expect(
      within(rowOf('localhost:1883')).getByRole('button', { name: /Let the pane go/ }),
    ).toBeInTheDocument();
  });

  it("holds the broker row's own counts while it is paused", async () => {
    const { send } = renderConsole();
    send(['sensors/temp', '21']);
    await pick('localhost:1883');
    await userEvent.click(holdOn('localhost:1883'));

    send(['sensors/temp', '22'], ['sensors/humidity', '55']);

    expect(rowOf('localhost:1883')).toHaveTextContent('1 topic · 1 message');
  });

  it('freezes $SYS with everything else when the broker row is paused, rather than hiding it', async () => {
    const { send } = renderConsole();
    send(['$SYS/broker/uptime', '10'], ['sensors/temp', '21']);
    await pick('localhost:1883');
    await userEvent.click(holdOn('localhost:1883'));

    send(['$SYS/broker/uptime', '11']);

    expect(rowFor('$SYS')).not.toBeNull();
    expect(rowOf('uptime')).toHaveTextContent('10');
  });

  it('draws / from its own hold once the broker row it was taken under is let go', async () => {
    const { send } = renderConsole();
    send(['/hfp/bus/one', 'a1']);
    await pick('localhost:1883');
    await userEvent.click(holdOn('localhost:1883'));
    send(['/hfp/bus/one', 'a2']);
    await pick('/');
    await userEvent.click(within(rowOf('/')).getByRole('button', { name: 'Pause the pane on its own' }));

    await userEvent.click(within(rowOf('localhost:1883')).getByRole('button', { name: /Let the pane go/ }));

    expect(rowOf('one')).toHaveTextContent('a1');
  });

  it('counts traffic held under nested holds once on the rows above', async () => {
    const { send } = renderConsole();
    send(['plant/sensors/temp', '21'], ['plant/sensors/humidity', '55']);
    await pick('temp');
    await userEvent.click(holdControl());
    await pick('sensors');
    await userEvent.click(within(rowOf('sensors')).getByRole('button', { name: 'Pause the pane' }));

    send(['plant/sensors/temp', '99']);

    expect(rowOf('plant')).toHaveTextContent('2 topics · 2 messages');
    expect(rowOf('localhost:1883')).toHaveTextContent('2 topics · 2 messages');
  });
});
