import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient as render } from '../../test/renderWithClient';
import { server } from '../../test/server';
import { byteLength } from '../../lib/payload';
import type { DecodedMessage } from '../../realtime/decodeIncoming';
import { useComposeStore } from '../../stores/composeStore';
import { useLogStore } from '../../stores/logStore';
import { useSelectionStore } from '../../stores/selectionStore';
import { useWindows } from './useWindows';
import { useZoomStore } from './useZoom';
import { WireLog } from './WireLog';
import { Windows } from './Windows';

const chip = { label: 'sensors/#', filter: 'sensors/#' };

const Console = () => (
  <>
    <WireLog />
    <Windows />
  </>
);

/** An arrival as the hub hands one over, so the entry carries its size and its mode. */
const arrival = (over: Partial<DecodedMessage> = {}): DecodedMessage => ({
  topic: 'sensors/room/temp',
  payload: '22.7',
  mode: 'text',
  size: byteLength('22.7'),
  qos: 1,
  retain: false,
  receivedAt: '2026-07-26T10:00:00.250Z',
  ...over,
});

const landed = (...messages: DecodedMessage[]) =>
  act(() => useLogStore.getState().appendReceived(messages));

const openIt = async () => userEvent.click(screen.getByTestId('open'));

beforeEach(() => {
  useLogStore.getState().clear();
  useSelectionStore.getState().clear();
  useComposeStore.setState({ draft: null });
  useWindows.setState({ windows: [] });
  useZoomStore.setState({ zoomed: false, box: null });
  useSelectionStore.getState().select(chip);
});

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'clipboard');
  window.getSelection()?.removeAllRanges();
});

describe('opening one message', () => {
  it('offers a control in every arrival row, with no word on it', () => {
    landed(arrival());

    render(<Console />);

    const button = screen.getByTestId('open');
    expect(button).toHaveAccessibleName('Open the message on sensors/room/temp in a window');
    expect(button).toHaveTextContent('');
  });

  // The head line is furniture read left to right, and the control is not part of it — it sits in
  // the row's own corner, out of the flow, so the head reads exactly as it did.
  it('leaves the head line alone', () => {
    landed(arrival({ retain: true }));

    render(<Console />);

    expect(screen.getByTestId('head')).toHaveTextContent(/^\d\d:\d\d:\d\dQoS 1RETAINED4Bload$/);
  });

  it('opens one window, without loading the row into publish', async () => {
    landed(arrival());
    render(<Console />);

    await openIt();

    expect(screen.getByTestId('message-window')).toBeInTheDocument();
    expect(screen.getByTestId('loaded')).toHaveTextContent('');
    expect(useComposeStore.getState().draft).toBeNull();
  });

  it('opens on a double click of the payload, and does nothing on a single one', () => {
    landed(arrival());
    render(<Console />);

    fireEvent.click(screen.getByTestId('body'), { detail: 1 });
    expect(screen.queryByTestId('message-window')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('body'), { detail: 2 });
    expect(screen.getByTestId('message-window')).toBeInTheDocument();
  });

  // Pressing the same row again is 'where did that go', not 'give me another one'. Two charts of
  // one topic can differ; two windows on one frozen arrival cannot.
  it('brings the window it already has forward rather than opening a second', async () => {
    landed(arrival());
    render(<Console />);

    await openIt();
    await openIt();

    expect(screen.getAllByTestId('message-window')).toHaveLength(1);
  });

  it('closes on Escape', async () => {
    landed(arrival());
    render(<Console />);
    await openIt();

    await userEvent.keyboard('{Escape}');

    expect(screen.queryByTestId('message-window')).not.toBeInTheDocument();
  });

  // The thrown-open chart is drawn above every window and has its own Escape; one keypress must
  // not put both away.
  it('leaves the window alone while the chart is thrown open', async () => {
    landed(arrival());
    render(<Console />);
    await openIt();
    act(() => useZoomStore.setState({ zoomed: true }));

    await userEvent.keyboard('{Escape}');

    expect(screen.getByTestId('message-window')).toBeInTheDocument();
  });
});

describe('what the window says about the message', () => {
  /** The window's own summary, which is a topic and a time and whatever the chips could not say. */
  const summary = () => screen.getByTestId('summary');
  /** The chips in the window's bar. Named apart from the row's, which carries the same strings. */
  const chips = () => screen.getByTestId('stamps');

  it('answers the questions the row cannot', async () => {
    landed(arrival({ payload: 'ok', size: byteLength('ok'), qos: 2, retain: true }));
    render(<Console />);

    await openIt();

    expect(summary()).toHaveTextContent('sensors/room/temp');
    expect(chips()).toHaveTextContent('QoS 2');
    expect(chips()).toHaveTextContent('RETAINED');
    expect(chips()).toHaveTextContent('2B');
    // To the millisecond, which is what a reader comparing two arrivals is reading.
    expect(summary()).toHaveTextContent(/\.250/);
  });

  // The row's own strings rather than a second opinion about them, which is the whole promise of
  // the bar: a reader is meant to recognise the boxes they double-clicked a second before.
  it('wears the chips the row it came from is wearing', async () => {
    landed(arrival({ payload: 'ok', size: byteLength('ok'), qos: 2, retain: true }));
    render(<Console />);

    await openIt();

    const worn = within(screen.getByTestId('head')).getByText('QoS 2').parentElement!;
    expect(chips()).toHaveTextContent(worn.textContent!);
  });

  // The log stamps nothing when retain is false, which is the right silence in a run of
  // twenty-five rows and the wrong one in a window opened to ask exactly this.
  it('says not retained rather than leaving it out', async () => {
    landed(arrival());
    render(<Console />);

    await openIt();

    expect(chips()).toHaveTextContent('not retained');
  });

  // Both answers in the same place, so the reader looks once. It went where RETAINED stands:
  // second, straight after the QoS chip.
  it('puts either answer where the other one would have been', async () => {
    landed(arrival());
    render(<Console />);
    await openIt();

    const said = [...chips().children].map((chip) => chip.textContent);

    expect(said).toEqual(['QoS 1', 'not retained', '4B']);
  });

  // A retained clear carries nothing, which is the message.
  it('says nothing weighs nothing, and draws no payload', async () => {
    landed(arrival({ payload: '', size: 0 }));
    render(<Console />);

    await openIt();

    expect(chips()).toHaveTextContent('0B');
    expect(screen.queryByTestId('window-body')).not.toBeInTheDocument();
  });

  // What a message weighed is said once, in the chip upstairs. It was being answered a second
  // time underneath in more words, which was the old table refusing to be deleted.
  it('leaves the weight to the chip that already carries it', async () => {
    const payload = 'x'.repeat(2048);
    landed(arrival({ payload, size: byteLength(payload) }));
    render(<Console />);

    await openIt();

    expect(chips()).toHaveTextContent('2.0kB');
    expect(summary()).not.toHaveTextContent('bytes');
  });

  // The topic is the first line, at reading size and in its rule's colour, and it says what it is
  // by being that. The word 'topic' stood in front of it until it was read out loud: a window
  // opened from a row that was already showing the path, with a label naming the path.
  it('names the topic by drawing it, not by labelling it', async () => {
    landed(arrival());
    render(<Console />);

    await openIt();

    expect(summary()).toHaveTextContent('sensors/room/temp');
    expect(within(summary()).queryByText('topic')).not.toBeInTheDocument();
  });

  // Two questions on one line, and the second one held against the far end.
  it('holds the moment it landed at the end of the topic line', async () => {
    landed(arrival());
    render(<Console />);

    await openIt();

    const landedAt = within(summary()).getByText(/^\d\d\/\d\d\/\d{4},/);
    expect(landedAt.tagName).toBe('TIME');
    expect(landedAt.previousElementSibling).toHaveTextContent('sensors/room/temp');
  });

  /*
   * The chips answer a question about the delivery and were being read as a verdict on the
   * publish behind it.
   *
   * 'I ticked Retain and the log says not retained' is a reasonable thing to think and was, for
   * one real fault, true. The rest of the time it is MQTT: a broker clears the retain bit on
   * every copy it forwards to a subscription that was already up, and sets it only on the copy it
   * sends because a subscription has just been made. The window is where that sentence goes —
   * this is the line built for what the chips cannot say.
   */
  it('says whose fact "not retained" is', async () => {
    landed(arrival());
    render(<Console />);

    await openIt();

    expect(summary()).toHaveTextContent('as delivered — a live copy always has retain cleared');
  });

  // A retained arrival's chip is already the whole answer; the line exists for what is missing.
  it('says nothing of the kind about a message that did arrive retained', async () => {
    landed(arrival({ retain: true }));
    render(<Console />);

    await openIt();

    expect(summary()).not.toHaveTextContent('as delivered');
  });

  // The QoS number has the same shape of lie and cannot be qualified in words on every row, so it
  // is qualified where a title costs nothing. One place decides what a chip says; the same place
  // says what it means.
  it('explains the delivered QoS and the retain flag on the chips themselves', async () => {
    landed(arrival());
    render(<Console />);

    await openIt();

    expect(within(chips()).getByText('QoS 1')).toHaveAttribute(
      'title',
      expect.stringContaining('A subscription caps the QoS of every copy sent under it'),
    );
    expect(within(chips()).getByText('not retained')).toHaveAttribute(
      'title',
      expect.stringContaining('clears that flag on every message it forwards'),
    );
  });

  it('gives a hex body its bytes and its characters, since the two differ', async () => {
    landed(arrival({ payload: 'de ad be ef', mode: 'hex', size: 4 }));
    render(<Console />);

    await openIt();

    expect(chips()).toHaveTextContent('BIN');
    expect(summary()).toHaveTextContent('11 characters of hex');
  });
});

describe('the payload, formatted where formatting is what it is', () => {
  const body = () => screen.getByTestId('window-body');

  /*
   * The controls stand in the document's corner rather than on a row of their own.
   *
   * Four marks laid out across a full width read as a caption on the message; the same four in
   * the corner read as things you do to what is beside them — and on a narrow window the row they
   * used to take was a whole line of chrome above the message the window was opened to read. What
   * must not change is which box is the message: Ctrl+A and the copy mark both take
   * [data-message], and a control swept into that box would be pasted into a bug report as part
   * of a message that never carried it.
   */
  it('keeps the controls beside the document rather than above it, and out of the message', async () => {
    const payload = '{"a":1,"b":[2]}';
    landed(arrival({ payload, size: byteLength(payload) }));
    render(<Console />);
    await openIt();

    const away = screen.getByRole('button', { name: 'Fold every branch' });
    const copy = screen.getByTestId('copy');

    expect(body()).not.toContainElement(away);
    expect(body()).not.toContainElement(copy);
    // The same box holds both, and it is the box the document is drawn in.
    expect(away.parentElement?.parentElement).toContainElement(body());
  });

  it('lays out a JSON document, and hands back exactly what arrived', async () => {
    const payload = '{"a":1,"b":[2]}';
    landed(arrival({ payload, size: byteLength(payload) }));
    render(<Console />);
    await openIt();

    expect(body()).toHaveTextContent('"a": 1');

    await userEvent.click(screen.getByRole('button', { name: 'json' }));

    expect(body().textContent).toBe(payload);
  });

  it('says why it is not laying out a body that meant to be JSON', async () => {
    const payload = '{"a":1';
    landed(arrival({ payload, size: byteLength(payload) }));
    render(<Console />);

    await openIt();

    expect(within(screen.getByTestId('message-window')).getByText(/Line 1/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'json' })).not.toBeInTheDocument();
  });

  // JSON.parse takes a bare number, and calling 21.5 a JSON document helps nobody.
  it('leaves a plain reading alone', async () => {
    landed(arrival({ payload: '21.5', size: byteLength('21.5') }));
    render(<Console />);

    await openIt();

    expect(body().textContent).toBe('21.5');
    expect(screen.queryByRole('button', { name: 'json' })).not.toBeInTheDocument();
  });

  // Every branch of it folds, and the fold says how many things went away with it — 'radios'
  // with nothing after it is a question rather than an answer.
  it('folds a branch of a document away, and says what is inside it', async () => {
    const payload = '{"a":1,"radios":[{"id":"radio-0"},{"id":"radio-1"}]}';
    landed(arrival({ payload, size: byteLength(payload) }));
    render(<Console />);
    await openIt();

    expect(body()).toHaveTextContent('"radio-0"');

    await userEvent.click(screen.getByRole('button', { name: 'Fold radios' }));

    expect(body()).not.toHaveTextContent('"radio-0"');
    expect(body()).toHaveTextContent('"radios": [ … 2 ]');
  });

  it('shuts and opens the whole document at once', async () => {
    const payload = '{"a":1,"radios":[{"id":"radio-0"}]}';
    landed(arrival({ payload, size: byteLength(payload) }));
    render(<Console />);
    await openIt();

    await userEvent.click(screen.getByRole('button', { name: 'Fold every branch' }));
    expect(body()).not.toHaveTextContent('"a": 1');

    await userEvent.click(screen.getByRole('button', { name: 'Open every branch' }));
    expect(body()).toHaveTextContent('"radio-0"');
  });

  /**
   * A long document gets a map of its own top level, down the side.
   *
   * Fully unfolded, a gateway's first key is on line two and its last on line forty, and the only
   * gesture that put them together folded the whole thing to one line.
   */
  describe('what is in the message', () => {
    // Real shape, real names: a gateway reporting itself on connect.
    const gateway = JSON.stringify({
      gateway: { id: 'gw-forge-01', firmware: '4.2.1-rc3', uptime: 918273, bootCount: 42 },
      network: { uplink: 'ethernet', ip: '10.4.18.22', rssi: -54 },
      radios: [
        { id: 'radio-0', channel: 11, dbm: -42 },
        { id: 'radio-1', channel: 12, dbm: -43 },
      ],
      counters: { published: 184392, delivered: 184388, dropped: 4 },
    });

    it('says what is at the top of a document too long to show it', async () => {
      landed(arrival({ payload: gateway, size: byteLength(gateway) }));
      render(<Console />);
      await openIt();

      const index = screen.getByTestId('index');
      expect(within(index).getByRole('button', { name: 'Go to radios, 2 inside' })).toBeInTheDocument();
      expect(within(index).getByRole('button', { name: 'Go to counters, 3 inside' })).toBeInTheDocument();
    });

    // A message of three keys and eighteen lines is entirely on screen in any window worth
    // opening one in, and a ruled strip beside it is a map of a room you are standing in.
    it('draws none beside a document you can see all of', async () => {
      const small = '{"a":1,"radios":[{"id":"radio-0"}]}';
      landed(arrival({ payload: small, size: byteLength(small) }));
      render(<Console />);
      await openIt();

      expect(screen.queryByTestId('index')).not.toBeInTheDocument();
    });

    // Folded, a branch has no row to go to — so the way to it is opened first. Only that one:
    // the reader's other folds are theirs.
    it('opens the branch it is sent to, and leaves the rest folded', async () => {
      landed(arrival({ payload: gateway, size: byteLength(gateway) }));
      render(<Console />);
      await openIt();

      await userEvent.click(screen.getByRole('button', { name: 'Fold every branch' }));
      await userEvent.click(screen.getByRole('button', { name: 'Go to radios, 2 inside' }));

      expect(screen.getByRole('button', { name: 'Fold radios' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Open counters' })).toBeInTheDocument();
    });

    // The whole reason it is a sibling of the payload rather than a child of it.
    it('stays out of the message when the whole message is taken', async () => {
      landed(arrival({ payload: gateway, size: byteLength(gateway) }));
      render(<Console />);
      await openIt();

      await userEvent.keyboard('{Control>}a{/Control}');

      const taken = window.getSelection()!.getRangeAt(0).toString();
      expect(JSON.parse(taken)).toEqual(JSON.parse(gateway));
    });
  });

  // A folded branch on screen is a summary, and a summary pasted into a bug report is a message
  // that never existed. The mark in the corner hands over what arrived.
  it('copies exactly what arrived, whatever is folded away', async () => {
    const payload = '{"a":1,"radios":[{"id":"radio-0"}]}';
    // Defined rather than spied on: jsdom carries no clipboard at all, and there is nothing on
    // navigator to put a getter over.
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => void written.push(text) },
    });

    landed(arrival({ payload, size: byteLength(payload) }));
    render(<Console />);
    await openIt();
    await userEvent.click(screen.getByRole('button', { name: 'Fold every branch' }));

    await userEvent.click(screen.getByTestId('copy'));

    expect(written).toEqual([payload]);
    expect(screen.getByTestId('copy')).toHaveAccessibleName('Copied');
  });

  // The browser's own answer to this is the whole console behind the window, which is never what
  // anybody meant by it here.
  it('selects the message on ctrl-A rather than the console behind it', async () => {
    landed(arrival());
    render(<Console />);
    await openIt();

    await userEvent.keyboard('{Control>}a{/Control}');

    const selection = window.getSelection()!;
    expect(selection.rangeCount).toBe(1);
    expect(selection.getRangeAt(0).commonAncestorContainer).toBe(body());
  });

  // And what comes back is the document, not the furniture around it. The chevrons were written
  // into the buttons at first, which put a '▾' at the head of every branch in the copy — JSON
  // that no longer parses, out of the window whose job is handing over what arrived.
  it('gives back JSON that still parses when the whole of it is taken', async () => {
    const payload = '{"a":1,"radios":[{"id":"radio-0"},{"id":"radio-1"}]}';
    landed(arrival({ payload, size: byteLength(payload) }));
    render(<Console />);
    await openIt();

    await userEvent.keyboard('{Control>}a{/Control}');

    const taken = window.getSelection()!.getRangeAt(0).toString();
    expect(JSON.parse(taken)).toEqual(JSON.parse(payload));
  });

  it('leaves a byte dump alone', async () => {
    landed(arrival({ payload: '7b 22 61 22', mode: 'hex', size: 4 }));
    render(<Console />);

    await openIt();

    expect(body().textContent).toBe('7b 22 61 22');
    expect(screen.queryByRole('button', { name: 'json' })).not.toBeInTheDocument();
  });

  // The row clamps because a pane full of one payload is a pane with nothing else in it. A window
  // opened onto one message has no such problem, and showing it whole is what it is for.
  it('shows the whole of a body the row had to clamp', async () => {
    const payload = 'x'.repeat(40_000);
    landed(arrival({ payload, size: byteLength(payload) }));
    render(<Console />);

    expect(screen.getByTestId('body')).toHaveAttribute('data-clipped');

    await openIt();

    expect(body().textContent).toHaveLength(40_000);
  });
});

/**
 * The window and the row it was opened from are one message, so they wear the same rule — the
 * topic in the rule's colour, and the payload in the second one where the rule carries it.
 *
 * With one exception, and it is the interesting half: a document drawn as a foldable tree already
 * says what each value IS in four colours of its own, and one colour over the lot would trade a
 * reading of the document for a reminder of which rule the reader already picked the window off.
 */
describe('the message colour in an opened window', () => {
  const rules = (...rules: Array<{ filter: string; colour: string; bodyColour?: string | null }>) =>
    server.use(http.get('/api/colour-rules', () => HttpResponse.json({ rules })));

  const body = () => screen.getByTestId('window-body');

  it('draws a payload that is text in the rule`s message colour', async () => {
    rules({ filter: 'sensors/#', colour: '#b45309', bodyColour: '#1e40af' });
    landed(arrival({ payload: '22.7' }));
    render(<Console />);

    await openIt();

    await waitFor(() => expect(body()).toHaveStyle({ color: '#1e40af' }));
    expect(body()).toHaveAttribute('data-mode', 'text');
  });

  it('leaves a document to the tree`s own colours', async () => {
    rules({ filter: 'sensors/#', colour: '#b45309', bodyColour: '#1e40af' });
    landed(arrival({ payload: '{"t":22.7}' }));
    render(<Console />);

    await openIt();

    await waitFor(() => expect(body()).toHaveAttribute('data-mode', 'tree'));
    expect(body().style.color).toBe('');
  });

  it('leaves the payload in the console`s ink when the rule paints only the topic', async () => {
    rules({ filter: 'sensors/#', colour: '#b45309' });
    landed(arrival({ payload: '22.7' }));
    render(<Console />);

    await openIt();

    await waitFor(() => expect(screen.getByTestId('summary')).toHaveTextContent('sensors/#'));
    expect(body().style.color).toBe('');
  });
});
