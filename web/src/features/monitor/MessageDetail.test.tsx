import { act, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderWithClient as render } from '../../test/renderWithClient';
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

    expect(summary()).toHaveTextContent('not retained');
  });

  // A retained clear carries nothing, which is the message.
  it('says nothing weighs nothing, and draws no payload', async () => {
    landed(arrival({ payload: '', size: 0 }));
    render(<Console />);

    await openIt();

    expect(chips()).toHaveTextContent('0B');
    expect(screen.queryByTestId('window-body')).not.toBeInTheDocument();
  });

  // The chip rounds everything past a kilobyte, so 2048 and 2099 bytes stamp the same word. The
  // window is where the number it was rounded from lives.
  it('gives the exact count where the chip had to round it', async () => {
    const payload = 'x'.repeat(2048);
    landed(arrival({ payload, size: byteLength(payload) }));
    render(<Console />);

    await openIt();

    expect(chips()).toHaveTextContent('2.0kB');
    expect(summary()).toHaveTextContent('2048 bytes');
  });

  // Under a kilobyte the chip is already the exact number, and saying it again in more words is
  // the old table with two rows deleted.
  it('leaves a small body to its chip alone', async () => {
    landed(arrival({ payload: 'ok', size: byteLength('ok'), retain: true }));
    render(<Console />);

    await openIt();

    expect(summary()).not.toHaveTextContent('bytes');
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
