import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// The log reads its colour rules through react-query, so every render here needs a client.
import { renderWithClient as render } from '../../test/renderWithClient';
import { server } from '../../test/server';
import { byteLength } from '../../lib/payload';
import type { DecodedMessage } from '../../realtime/decodeIncoming';
import { useAppearanceStore } from '../../stores/appearanceStore';
import { useComposeStore } from '../../stores/composeStore';
import { MAX_LOG_ENTRIES, useLogStore } from '../../stores/logStore';
import { useSelectionStore } from '../../stores/selectionStore';
import { TrafficPane } from './TrafficPane';
import { useHoldStore } from './useTraffic';
import { WireLog } from './WireLog';

const chip = { label: 'sensors/#', filter: 'sensors/#' };

// The entries and the chart are two regions of the right column now, reading the same run. The
// workspace stacks them; here they are rendered together for the same reason.
const Monitor = () => (
  <>
    <WireLog />
    <TrafficPane />
  </>
);

/** What the note is showing in one of its fixed slots — a dash when it has nothing to say. */
const reading = (slot: string) => screen.getByTestId(`reading-${slot}`).textContent;

// Oldest first, so the newest lands at the head of the store.
const received = (...topics: string[]) =>
  topics.forEach((topic) => useLogStore.getState().push({ kind: 'recv', topic }));

// Already decoded, the way the hub bridge hands arrivals to the log — this bypasses the hub.
const msg = (topic: string): DecodedMessage => ({
  topic,
  payload: '1',
  mode: 'text',
  size: byteLength('1'),
  qos: 0,
  retain: false,
  receivedAt: '2026-07-26T10:00:00Z',
});

beforeEach(() => {
  useLogStore.getState().clear();
  useSelectionStore.getState().clear();
  useComposeStore.setState({ draft: null });
  useHoldStore.getState().release();
  // The chart's detail is a stored preference, so a test that changes it would leak into the next.
  useAppearanceStore.getState().reset();
});

describe('WireLog', () => {
  it('asks for a topic while nothing is selected', () => {
    received('sensors/room/temp');

    render(<Monitor />);

    expect(
      screen.getByText('Pick a topic — click a subscription chip or a tree node to see its traffic here.'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('entry')).not.toBeInTheDocument();
  });

  // The reported symptom: the tree shows a topic carrying traffic, the pane calls it silent.
  it('still has the traffic of a quiet topic after a chatty one has flooded the log', () => {
    useLogStore.getState().appendReceived([msg('sensors/attic/temp')]);
    useLogStore
      .getState()
      .appendReceived(Array.from({ length: MAX_LOG_ENTRIES * 2 }, () => msg('sensors/hall/temp')));
    useSelectionStore.getState().select({ label: 'sensors/attic', filter: 'sensors/attic/#' });

    render(<Monitor />);

    expect(screen.queryByText(/No traffic on/)).not.toBeInTheDocument();
    expect(screen.getByTestId('topic')).toHaveTextContent('sensors/attic/temp');
  });

  it('says the selected topic is quiet when nothing has matched it yet', () => {
    received('actuators/valve');
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    expect(screen.getByText('No traffic on sensors/# yet.')).toBeInTheDocument();
  });

  it('keeps only the entries matching the selected filter', async () => {
    received('sensors/room/temp', 'actuators/valve', 'sensors/hall/temp');
    useSelectionStore.getState().select(chip);

    render(<Monitor />);
    await userEvent.click(screen.getByRole('button', { name: '2 in history' }));

    const topics = screen.getAllByTestId('topic').map((topic) => topic.textContent);
    expect(topics).toEqual(['sensors/hall/temp', 'sensors/room/temp']);
  });

  it('shows the messages on the topic and leaves the command entries out', () => {
    useLogStore.getState().push({ kind: 'ok', verb: 'Subscribed', topic: 'sensors/#' });
    useLogStore.getState().push({ kind: 'fault', verb: 'Subscribe failed', topic: 'sensors/#' });
    received('sensors/room/temp');
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    const topics = screen.getAllByTestId('topic').map((topic) => topic.textContent);
    expect(topics).toEqual(['sensors/room/temp']);
  });

  // A command's filter is not a topic, so a selection matching it says nothing about traffic.
  it('calls the topic quiet when only commands have named it', () => {
    useLogStore.getState().push({ kind: 'ok', verb: 'Subscribed', topic: 'sensors/#' });
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    expect(screen.getByText('No traffic on sensors/# yet.')).toBeInTheDocument();
  });

  it('shows the newest arrival alone, over the count the log holds', () => {
    received(...Array.from({ length: 8 }, (_, i) => `sensors/${i}`));
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    expect(screen.getAllByTestId('entry')).toHaveLength(1);
    expect(screen.getByTestId('topic')).toHaveTextContent('sensors/7');
    expect(screen.getByRole('button', { name: '8 in history' })).toBeInTheDocument();
  });

  // The count answers 'how much history is there on this topic', so what the log holds for other
  // topics is not part of it.
  it('counts what the selection holds rather than the whole log', () => {
    received('sensors/a', 'actuators/valve', 'sensors/b');
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    expect(screen.getByRole('button', { name: '2 in history' })).toBeInTheDocument();
  });

  it('reveals the rest on demand and folds them back', async () => {
    received(...Array.from({ length: 8 }, (_, i) => `sensors/${i}`));
    useSelectionStore.getState().select(chip);

    render(<Monitor />);
    await userEvent.click(screen.getByRole('button', { name: '8 in history' }));

    expect(screen.getAllByTestId('entry')).toHaveLength(8);

    await userEvent.click(screen.getByRole('button', { name: 'Show fewer' }));

    expect(screen.getAllByTestId('entry')).toHaveLength(1);
  });

  // Still counted, since 'how much is here' is worth an answer either way — but there is nothing
  // behind it to reveal, so it is a readout rather than a handle.
  it('states the count without offering to expand a lone entry', () => {
    received('sensors/a');
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    expect(screen.getByText('1 in history')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '1 in history' })).not.toBeInTheDocument();
  });

  // Which element carries the count depends on whether there is history behind it, and that is a
  // fact about what it does, not about how it reads: one line of type either way.
  it('sets the count in the same type whether or not it opens onto anything', () => {
    const look = (element: HTMLElement) => {
      const style = getComputedStyle(element);
      return [style.fontFamily, style.fontSize, style.letterSpacing, style.textTransform, style.color]
        .join(' ');
    };

    received('sensors/a');
    useSelectionStore.getState().select(chip);
    const lone = render(<Monitor />);
    const readout = look(screen.getByText('1 in history'));
    lone.unmount();

    received('sensors/b');
    render(<Monitor />);

    expect(look(screen.getByRole('button', { name: '2 in history' }))).toBe(readout);
  });

  it('folds the list back up when the selection changes', async () => {
    received(...Array.from({ length: 8 }, (_, i) => `sensors/${i}`));
    received(...Array.from({ length: 8 }, (_, i) => `actuators/${i}`));
    useSelectionStore.getState().select(chip);

    render(<Monitor />);
    await userEvent.click(screen.getByRole('button', { name: '8 in history' }));
    act(() => useSelectionStore.getState().select({ label: 'actuators', filter: 'actuators/#' }));

    expect(screen.getAllByTestId('entry')).toHaveLength(1);
  });

  // The entries start at the pane's edge. What they are about is on every row already, so a
  // strip naming the selection again was a line of furniture over a list that reads without it.
  it('draws no head row above the entries', () => {
    received('sensors/room/temp');
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    expect(screen.queryByTestId('focus')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear topic selection' })).not.toBeInTheDocument();
  });

  it('splits the topic on slashes so the separators can be dimmed', () => {
    received('sensors/room/temp');
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    const topic = screen.getByTestId('topic');
    expect(topic).toHaveTextContent('sensors/room/temp');
    expect(within(topic).getAllByTestId('sep')).toHaveLength(2);
  });

  it('shows the stamps and the body', () => {
    useLogStore.getState().push({
      kind: 'recv',
      topic: 'sensors/room/temp',
      body: '21.5',
      stamps: ['QoS 1', 'RETAINED', '4B'],
    });
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    expect(screen.getByText('QoS 1')).toBeInTheDocument();
    expect(screen.getByText('RETAINED')).toBeInTheDocument();
    expect(screen.getByText('4B')).toBeInTheDocument();
    expect(screen.getByText('21.5')).toBeInTheDocument();
  });

  // One line of furniture over the topic, read left to right, rather than the stamps trailing
  // the topic on the line below.
  it('runs the time and the stamps along a single line', () => {
    useLogStore.getState().push({
      kind: 'recv',
      topic: 'sensors/room/temp',
      stamps: ['QoS 1', 'RETAINED', '4B'],
    });
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    const head = screen.getByTestId('head');
    expect(head).toHaveTextContent(/^\d\d:\d\d:\d\dQoS 1RETAINED4B$/);
    expect(within(screen.getByTestId('topic')).queryByText('4B')).not.toBeInTheDocument();
  });

  it('names each stamp so retained messages can be coloured apart', () => {
    useLogStore.getState().push({
      kind: 'recv',
      topic: 'sensors/room/temp',
      stamps: ['QoS 1', 'RETAINED'],
    });
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    expect(screen.getByText('RETAINED')).toHaveAttribute('data-stamp', 'RETAINED');
  });

  it('marks each entry with its kind, which drives the colour', () => {
    received('sensors/room/temp');
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    expect(screen.getByTestId('entry')).toHaveAttribute('data-kind', 'recv');
  });

  it('sends a logged message back to publish, settings and all', async () => {
    useLogStore.getState().push({
      kind: 'recv',
      topic: 'sensors/temp',
      body: '21.5',
      qos: 2,
      retain: true,
    });
    useSelectionStore.getState().select(chip);
    render(<Monitor />);

    await userEvent.click(screen.getByRole('button', { name: 'Load sensors/temp into publish' }));

    expect(useComposeStore.getState().draft).toMatchObject({
      topic: 'sensors/temp',
      payload: '21.5',
      qos: 2,
      retain: true,
    });
  });

  it('holds off loading when the click is the end of a text selection', () => {
    useLogStore.getState().push({ kind: 'recv', topic: 'sensors/temp', body: '21.5' });
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    const body = screen.getByText('21.5');
    const range = document.createRange();
    range.selectNodeContents(body);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.click(body);

    expect(useComposeStore.getState().draft).toBeNull();
  });
});

// Under a flood, the row and the chart move under the reader while they are reading them. Every
// console has this problem; none of them has a way to stop it that does not also stop the log.
describe('holding the pane still', () => {
  const readings = (topic: string, ...bodies: string[]) =>
    bodies.forEach((body) => useLogStore.getState().push({ kind: 'recv', topic, body }));

  it('keeps showing what it was showing while the traffic carries on', async () => {
    readings('sensors/temp', '21', '22');
    useSelectionStore.getState().select(chip);

    render(<Monitor />);
    await userEvent.click(screen.getByRole('button', { name: 'Hold the pane' }));
    act(() => readings('sensors/temp', '99'));

    expect(screen.getByTestId('body')).toHaveTextContent('22');
    expect(screen.getByRole('button', { name: /2 in history/ })).toBeInTheDocument();
  });

  it('says how many arrived while it was held', async () => {
    readings('sensors/temp', '21', '22');
    useSelectionStore.getState().select(chip);

    render(<Monitor />);
    await userEvent.click(screen.getByRole('button', { name: 'Hold the pane' }));
    act(() => readings('sensors/temp', '23', '24', '25'));

    expect(screen.getByRole('button', { name: 'Let the pane go, 3 arrived while held' })).toBeInTheDocument();
  });

  it('counts nothing while nothing has arrived behind it', async () => {
    readings('sensors/temp', '21', '22');
    useSelectionStore.getState().select(chip);

    render(<Monitor />);
    await userEvent.click(screen.getByRole('button', { name: 'Hold the pane' }));

    expect(screen.getByRole('button', { name: 'Let the pane go' })).toHaveTextContent('held');
  });

  it('catches up when it is let go', async () => {
    readings('sensors/temp', '21', '22');
    useSelectionStore.getState().select(chip);

    render(<Monitor />);
    await userEvent.click(screen.getByRole('button', { name: 'Hold the pane' }));
    act(() => readings('sensors/temp', '99'));
    await userEvent.click(screen.getByRole('button', { name: /Let the pane go/ }));

    expect(screen.getByTestId('body')).toHaveTextContent('99');
  });

  it('lets go by itself when the selection changes', async () => {
    readings('sensors/temp', '21', '22');
    readings('sensors/hall', '31', '32');
    useSelectionStore.getState().select(chip);

    render(<Monitor />);
    await userEvent.click(screen.getByRole('button', { name: 'Hold the pane' }));
    act(() => useSelectionStore.getState().select({ label: 'sensors/hall', filter: 'sensors/hall' }));

    expect(screen.getByRole('button', { name: 'Hold the pane' })).toBeInTheDocument();
  });
});

// A topic that sends numbers is sending a measurement, and a run of measurements has a shape the
// rows cannot show: the newest value says where a sensor is, not where it has been going.
describe('the chart over the entries', () => {
  const readings = (topic: string, ...bodies: string[]) =>
    bodies.forEach((body) => useLogStore.getState().push({ kind: 'recv', topic, body }));

  it('charts a topic that reads as numbers', () => {
    readings('sensors/temp', '21.5', '22.5', '20');
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    expect(screen.getByTestId('chart')).toBeInTheDocument();
  });

  it('plots every reading the log holds, not just the row on show', () => {
    readings('sensors/temp', ...Array.from({ length: 8 }, (_, i) => `${i}`));
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    expect(screen.getByTestId('plot').getAttribute('points')?.trim().split(/\s+/)).toHaveLength(8);
  });

  it('labels the high and the low, which is what the line alone cannot say', () => {
    readings('sensors/temp', '21.5', '24.25', '19');
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    expect(within(screen.getByTestId('chart')).getByText('24.25')).toBeInTheDocument();
    expect(within(screen.getByTestId('chart')).getByText('19')).toBeInTheDocument();
  });

  // The shape is the whole point of a chart, so what stands in for it has to carry the same
  // facts: how many readings, over what range, and where they ended up.
  it('says in words what the shape shows', () => {
    readings('sensors/temp', '21.5', '24', '19');
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    expect(screen.getByTestId('plotArea')).toHaveAccessibleName(
      /^3 readings on sensors\/temp, drawn from 19 to 24, latest 19/,
    );
  });

  // High and low are the same number, and printing it twice reads as two facts where there is one.
  it('gives a topic repeating one value a single label', () => {
    readings('sensors/temp', '21.5', '21.5', '21.5');
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    expect(within(screen.getByTestId('scale')).getAllByText('21.5')).toHaveLength(1);
  });

  // Where a reading can go either way, which side of nothing it is on is the first thing read
  // off the shape — and a line alone cannot say where nothing is.
  it('marks where zero is when the readings cross it', () => {
    readings('sensors/drift', '-2.5', '1.75', '-0.5');
    useSelectionStore.getState().select({ label: 'sensors/drift', filter: 'sensors/drift' });

    render(<Monitor />);

    expect(screen.getByTestId('zero')).toBeInTheDocument();
  });

  it('leaves zero unmarked when every reading is on one side of it', () => {
    readings('sensors/temp', '21.5', '22', '20');
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    expect(screen.queryByTestId('zero')).not.toBeInTheDocument();
  });

  // It used to draw nothing here and say 'a line needs one topic sending numbers', which named
  // neither this topic nor the reason. The reason is that the bodies are words, and the evidence
  // for that is the topic's own newest message.
  it('says the topic is not sending numbers, and shows what it is sending', () => {
    readings('sensors/state', 'ON', 'OFF', 'ON');
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    expect(screen.getByTestId('unchartable')).toHaveAttribute('data-reason', 'no-numbers');
    expect(screen.getByTestId('void-sample')).toHaveTextContent('ON');
  });

  it('says a run one message long is one message long, rather than unchartable', () => {
    readings('sensors/temp', '21.5');
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    expect(screen.getByTestId('unchartable')).toHaveAttribute('data-reason', 'too-few');
  });

  // A branch of the tree is several topics, and refusing it was the commonest way to end up with
  // no chart at all. °C and % sharing no axis is an argument for two scales, not for no chart.
  it('draws a plot per topic when the selection covers several', () => {
    readings('sensors/temp', '21.5', '22');
    readings('sensors/hum', '54', '55');
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    expect(screen.getByTestId('multiples')).toBeInTheDocument();
    expect(screen.getAllByTestId('plotArea')).toHaveLength(2);
  });

  it('takes the colour a rule gives the topic, the way the entries do', async () => {
    server.use(
      http.get('/api/colour-rules', () =>
        HttpResponse.json({ rules: [{ filter: 'sensors/temp', colour: '#b45309' }] }),
      ),
    );
    readings('sensors/temp', '21.5', '22');
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    await waitFor(() => expect(screen.getByTestId('plot')).toHaveAttribute('stroke', '#b45309'));
  });

  // The rows hold every value as text, but only five words of them at a time; the chart is where
  // an older reading is still on screen, so it has to be readable there too.
  it('reads out the value under the pointer', () => {
    readings('sensors/temp', '10', '20', '30', '40', '50');
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    const plot = screen.getByTestId('plotArea');
    vi.spyOn(plot, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 100 } as DOMRect);
    fireEvent.pointerMove(plot, { clientX: 50 });

    expect(screen.getByTestId('reading')).toHaveTextContent('30');

    fireEvent.pointerLeave(plot);

    expect(screen.queryByTestId('reading')).not.toBeInTheDocument();
  });
});

// Other consoles chart the values and stop there, leaving the reader to do the arithmetic by
// eye — which is the arithmetic an eye is worst at. What the run adds up to is written under it.
describe('what the chart says about the readings', () => {
  const readings = (topic: string, ...bodies: string[]) =>
    bodies.forEach((body) => useLogStore.getState().push({ kind: 'recv', topic, body }));

  // 1, 40, 2, 39 … — every value once, so the spread is even, and the run ends where it started.
  const evenSpread = () =>
    Array.from({ length: 20 }, (_, i) => [`${i + 1}`, `${40 - i}`]).flat();

  it('notes how many readings there are, where their middle is and how far they stray', () => {
    readings('sensors/temp', '20', '21', '22', '23', '24');
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    expect(reading('n')).toBe('5');
    expect(reading('mean')).toBe('22');
    expect(reading('median')).toBe('22');
    expect(reading('spread')).toBe('1.41');
    expect(reading('range')).toBe('20–24');
  });

  // Every value from one to forty, once each, in an order that goes nowhere: the uniform
  // distribution exactly, and with no trend on top of it for the note to prefer.
  it('names the shape the readings fall into', () => {
    readings('sensors/temp', ...evenSpread());
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    expect(reading('shape')).toContain('uniform');
  });

  // A ramp is uniform, and saying so of a draining battery is true and useless: the shape is the
  // trend, not a property of the readings around it. The direction is the reading that means
  // something, so it is the one that stays.
  it('names no shape for a run that is going somewhere', () => {
    readings('sensors/battery', ...Array.from({ length: 40 }, (_, i) => `${(3.9 - i * 0.004).toFixed(3)}`));
    useSelectionStore.getState().select({ label: 'sensors/battery', filter: 'sensors/battery' });

    render(<Monitor />);

    expect(reading('trend')).toContain('falling');
    expect(reading('shape')).toBe('—');
  });

  // 'Not enough evidence to reject' is what the test returns, and 'normal' flat out is more than
  // that — at these sample sizes the difference is the whole claim.
  it('hedges the shape it names', () => {
    readings('sensors/temp', ...evenSpread());
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    expect(reading('shape')).toBe('≈ uniform');
  });

  it('writes a range that crosses zero in words rather than dashes', () => {
    readings('sensors/drift', '-2.5', '-1', '0', '1.75', '-0.5', '2');
    useSelectionStore.getState().select({ label: 'sensors/drift', filter: 'sensors/drift' });

    render(<Monitor />);

    expect(reading('range')).toBe('-2.5 to 2');
  });

  it('names no shape for a run too short to have one', () => {
    readings('sensors/temp', '20', '21', '22', '23', '24');
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    expect(reading('shape')).toBe('—');
  });

  // The tolerance has to be visible: a chart quietly leaving messages out is a chart that lies
  // about how much of the topic it is showing.
  it('says how many messages it stepped over', () => {
    readings('sensors/temp', '21.5', 'sensor warming up', '22', '22.5');
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    expect(reading('skipped')).toBe('1');
  });

  // The chart's own window is not the log's: a note that said 'n 500' beside a history of five
  // thousand, without saying which five hundred, would be the chart quietly cropping the topic.
  it('says when it is charting a window of a longer run', () => {
    readings('sensors/temp', ...Array.from({ length: 620 }, (_, i) => `${20 + (i % 5)}`));
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    expect(reading('n')).toBe('500');
    expect(reading('window')).toBe('500 of 620');
  });

  it('counts nothing skipped when it read everything', () => {
    readings('sensors/temp', '21.5', '22', '22.5');
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    expect(reading('skipped')).toBe('0');
  });

  it('marks the readings that fall outside the fences', () => {
    readings('sensors/temp', '10', '11', '12', '11', '10', '12', '11', '90');
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    expect(screen.getAllByTestId('outlier')).toHaveLength(1);
    expect(reading('outliers')).toBe('1');
  });

  it('leaves a well behaved run unmarked', () => {
    readings('sensors/temp', '10', '11', '12', '11', '10', '12');
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    expect(screen.queryByTestId('outlier')).not.toBeInTheDocument();
  });

  // A sensor with a period is a sensor whose silence means something, and the period is the only
  // thing that says how long a silence has to be before it does.
  it('says how often the readings arrive', () => {
    useLogStore.getState().appendReceived(
      Array.from({ length: 6 }, (_, i) => ({
        topic: 'sensors/temp',
        payload: `${20 + i}`,
        mode: 'text' as const,
        size: 2,
        qos: 0,
        retain: false,
        receivedAt: new Date(2026, 0, 1, 12, 0, i).toISOString(),
      })),
    );
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    expect(reading('every')).toBe('1 s');
  });

  // A sensor with a rhythm is a sensor whose silence means something. No other console knows the
  // rhythm, so none of them can tell you the silence has started.
  const arrivals = (count: number, spacing: number, endedAgo: number) =>
    useLogStore.getState().appendReceived(
      Array.from({ length: count }, (_, i) => ({
        topic: 'sensors/temp',
        payload: `${20 + (i % 3)}`,
        mode: 'text' as const,
        size: 2,
        qos: 0,
        retain: false,
        receivedAt: new Date(Date.now() - endedAgo - (count - 1 - i) * spacing).toISOString(),
      })),
    );

  it('says when a topic that had a rhythm has gone quiet', () => {
    arrivals(8, 1000, 60_000);
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    expect(reading('silence')).not.toBe('—');
  });

  it('says nothing about silence while the readings are still coming', () => {
    arrivals(8, 1000, 0);
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    expect(reading('silence')).toBe('—');
  });

  // Without a rhythm there is no such thing as late: a topic nobody promised to publish on
  // cannot be overdue, and calling it silent would put a warning on every retained value.
  it('calls no topic silent when it never had a rhythm', () => {
    useLogStore.getState().appendReceived([
      {
        topic: 'sensors/temp',
        payload: '21',
        mode: 'text' as const,
        size: 2,
        qos: 0,
        retain: false,
        receivedAt: new Date(Date.now() - 600_000).toISOString(),
      },
      {
        topic: 'sensors/temp',
        payload: '22',
        mode: 'text' as const,
        size: 2,
        qos: 0,
        retain: false,
        receivedAt: new Date(Date.now() - 600_000).toISOString(),
      },
    ]);
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    expect(reading('silence')).toBe('—');
  });

  // A valve opened, a heater came on, a scale was reloaded. The mean of a run with a step in it
  // is a number that never happened, and the trend calls the step a gentle slope.
  it('says where a run stepped from one level to another, and marks it', () => {
    readings('sensors/temp', ...Array(20).fill('21'), ...Array(20).fill('26'));
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    expect(reading('step')).toContain('+5');
    expect(screen.getByTestId('step')).toBeInTheDocument();
  });

  it('calls no step on a run that is simply going somewhere', () => {
    readings('sensors/temp', ...Array.from({ length: 40 }, (_, i) => `${20 + i}`));
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    expect(reading('trend')).toContain('rising');
    expect(reading('step')).toBe('—');
  });

  it('calls no step on a run that only wobbles', () => {
    readings(
      'sensors/temp',
      ...Array.from({ length: 40 }, (_, i) => `${(21 + Math.sin(i * 2.3) * 0.5).toFixed(3)}`),
    );
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    expect(reading('step')).toBe('—');
    expect(screen.queryByTestId('step')).not.toBeInTheDocument();
  });

  // A thermostat, a pump, a compressor. A cycling sensor has an ordinary mean, an ordinary
  // spread and no trend at all, so nothing else in the note would say it was cycling.
  it('says how long a run takes to repeat itself', () => {
    readings(
      'sensors/temp',
      ...Array.from({ length: 72 }, (_, i) => `${(21 + Math.sin((2 * Math.PI * i) / 12) * 2).toFixed(2)}`),
    );
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    // These arrive in one instant, so there is no pace to turn the count into a time.
    expect(reading('cycle')).toBe('12 readings');
  });

  it('calls no cycle on a run that does not repeat', () => {
    readings('sensors/temp', ...Array.from({ length: 40 }, (_, i) => `${20 + i}`));
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    expect(reading('cycle')).toBe('—');
  });

  it('says which way a drifting run is going', () => {
    readings('sensors/temp', ...Array.from({ length: 12 }, (_, i) => `${20 + i}`));
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    expect(reading('trend')).toContain('rising');
  });

  it('calls no direction on a run that only wobbles', () => {
    readings('sensors/temp', '21', '22', '21', '22', '21', '22');
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    expect(reading('trend')).not.toMatch(/rising|falling/);
  });

  it('says a run that never moved is unchanged', () => {
    readings('sensors/temp', '21.5', '21.5', '21.5', '21.5');
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    expect(reading('trend')).toBe('unchanged');
  });
});

// A device that reports a whole environment in one message is one topic with several charts in
// it, and which one is wanted is the reader's business rather than ours.
describe('choosing what the chart draws', () => {
  const sends = (topic: string, ...bodies: object[]) =>
    bodies.forEach((body) =>
      useLogStore.getState().push({ kind: 'recv', topic, body: JSON.stringify(body) }),
    );

  const readings = (topic: string, ...bodies: string[]) =>
    bodies.forEach((body) => useLogStore.getState().push({ kind: 'recv', topic, body }));

  // Tabbing rather than focusing: that the plot is *reachable* from the keyboard is half of what
  // is being checked, and counting tabs would tie the test to everything else in the pane.
  const reachPlot = async () => {
    const plot = screen.getByTestId('plotArea');
    for (let step = 0; step < 12 && document.activeElement !== plot; step++) await userEvent.tab();
    return plot;
  };

  it('offers the numeric fields a JSON topic carries', () => {
    sends('sensors/env', { temp: 21.5, hum: 54 }, { temp: 22, hum: 55 });
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    expect(screen.getByRole('button', { name: 'Chart hum' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Chart temp' })).toBeInTheDocument();
  });

  it('charts the field that is picked', async () => {
    sends('sensors/env', { temp: 21.5, hum: 54 }, { temp: 22, hum: 55 });
    useSelectionStore.getState().select(chip);

    render(<Monitor />);
    await userEvent.click(screen.getByRole('button', { name: 'Chart temp' }));

    expect(screen.getByTestId('plotArea')).toHaveAccessibleName(/readings of temp/);
  });

  // Fields every message carries are tied on coverage, and the tie goes to the one doing
  // something: half a degree on twenty-one is a bigger move than a point of humidity on fifty.
  it('starts on the field that moves the most and says which one that is', async () => {
    sends('sensors/env', { temp: 21.5, hum: 54 }, { temp: 22, hum: 55 });
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    expect(screen.getByRole('button', { name: 'Chart temp' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Chart hum' })).toHaveAttribute('aria-pressed', 'false');

    await userEvent.click(screen.getByRole('button', { name: 'Chart hum' }));

    expect(screen.getByRole('button', { name: 'Chart hum' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Chart temp' })).toHaveAttribute('aria-pressed', 'false');
  });

  // The field a device reports in most of its messages is both the likeliest one wanted and the
  // one whose chart will have the fewest gaps in it.
  it('starts on the field most of the messages carry', () => {
    sends('sensors/env', { hum: 54 }, { temp: 22, hum: 55 }, { temp: 23 }, { temp: 24 });
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    expect(screen.getByRole('button', { name: 'Chart temp' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('offers no fields for a topic whose bodies are the numbers', () => {
    readings('sensors/temp', '21.5', '22');
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    expect(screen.queryByRole('button', { name: /^Chart / })).not.toBeInTheDocument();
  });

  // The line answers 'what has it been doing'; the histogram answers 'what does it usually do',
  // which is the question the distribution in the note is an answer to.
  it('turns the run into a distribution and back', async () => {
    readings('sensors/temp', ...Array.from({ length: 20 }, (_, i) => `${20 + (i % 5)}`));
    useSelectionStore.getState().select(chip);

    render(<Monitor />);
    await userEvent.click(screen.getByRole('button', { name: 'Distribution' }));

    expect(screen.getByTestId('histogram')).toBeInTheDocument();
    expect(screen.queryByTestId('plot')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Over time' }));

    expect(screen.getByTestId('plot')).toBeInTheDocument();
  });

  // A chart whose values can only be read by holding a mouse over them is a chart half the
  // readers cannot read at all.
  it('walks the readings from the keyboard', async () => {
    readings('sensors/temp', '10', '20', '30', '40', '50');
    useSelectionStore.getState().select(chip);

    render(<Monitor />);
    await reachPlot();

    // Landing on the plot starts at the newest reading, which is the one the row above shows.
    expect(screen.getByTestId('plotArea')).toHaveFocus();
    expect(screen.getByTestId('reading')).toHaveTextContent('50');

    await userEvent.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(screen.getByTestId('reading')).toHaveTextContent('30');

    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByTestId('reading')).toHaveTextContent('40');

    await userEvent.keyboard('{Home}');
    expect(screen.getByTestId('reading')).toHaveTextContent('10');

    await userEvent.keyboard('{End}');
    expect(screen.getByTestId('reading')).toHaveTextContent('50');
  });

  it('says out loud which reading it landed on', async () => {
    readings('sensors/temp', '10', '20', '30');
    useSelectionStore.getState().select(chip);

    render(<Monitor />);
    await reachPlot();
    await userEvent.keyboard('{ArrowLeft}');

    const spoken = screen.getByTestId('spoken');
    expect(spoken).toHaveAttribute('aria-live', 'polite');
    expect(spoken).toHaveTextContent('20');
  });

  it('drops the readout when the plot loses focus', async () => {
    readings('sensors/temp', '10', '20', '30');
    useSelectionStore.getState().select(chip);

    render(<Monitor />);
    await reachPlot();
    expect(screen.getByTestId('reading')).toBeInTheDocument();

    await userEvent.tab();
    expect(screen.queryByTestId('reading')).not.toBeInTheDocument();
  });

  // Every console can show a number. Getting the run out of the console and into whatever the
  // reader actually analyses in is the part they all leave undone.
  it('copies the readings out as CSV', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    readings('sensors/temp', '21.5', '22');
    useSelectionStore.getState().select(chip);

    render(<Monitor />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy as CSV' }));

    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('time,sensors/temp'));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('21.5'));
  });

  // Clipboard access is refused often enough — an insecure origin, a locked-down browser — that
  // a button which silently does nothing is a real outcome rather than a theoretical one.
  it('says so when the clipboard refuses', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    });
    readings('sensors/temp', '21.5', '22');
    useSelectionStore.getState().select(chip);

    render(<Monitor />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy as CSV' }));

    expect(await screen.findByRole('button', { name: 'Copy failed' })).toBeInTheDocument();
  });

  it('says when the readings have been copied', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
    readings('sensors/temp', '21.5', '22');
    useSelectionStore.getState().select(chip);

    render(<Monitor />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy as CSV' }));

    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });
});

// The same readings answer different questions for different readers, and which of those a
// console should answer is not ours to decide — it is a setting, next to the fonts.
describe('the three versions of the chart', () => {
  const readings = (topic: string, ...bodies: string[]) =>
    bodies.forEach((body) => useLogStore.getState().push({ kind: 'recv', topic, body }));

  const wave = () => Array.from({ length: 20 }, (_, i) => `${(21 + Math.sin(i) * 2).toFixed(2)}`);

  it('draws the line alone on plain', () => {
    useAppearanceStore.getState().setChart('plain');
    readings('sensors/temp', ...wave());
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    expect(screen.getByTestId('plotArea')).toBeInTheDocument();
    expect(screen.queryByTestId('note')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy as CSV' })).not.toBeInTheDocument();
  });

  it('draws the line, its marks and the note on full', () => {
    useAppearanceStore.getState().setChart('full');
    readings('sensors/temp', ...wave());
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    expect(screen.getByTestId('note')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy as CSV' })).toBeInTheDocument();
    expect(screen.queryByTestId('histogram')).not.toBeInTheDocument();
  });

  it('draws both views at once on deep, with the quartiles under them', () => {
    useAppearanceStore.getState().setChart('deep');
    readings('sensors/temp', ...wave());
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    expect(screen.getByTestId('plot')).toBeInTheDocument();
    expect(screen.getByTestId('histogram')).toBeInTheDocument();
    expect(reading('quartiles')).not.toBe('—');
    expect(reading('fences')).not.toBe('—');
    // Nothing to choose between when both are drawn.
    expect(screen.queryByRole('button', { name: 'Distribution' })).not.toBeInTheDocument();
  });

  it('keeps the readings reachable from the keyboard on every version', async () => {
    for (const version of ['plain', 'full', 'deep'] as const) {
      useAppearanceStore.getState().setChart(version);
      useLogStore.getState().clear();
      readings('sensors/temp', ...wave());
      useSelectionStore.getState().select(chip);

      const view = render(<Monitor />);
      const plot = screen.getByTestId('plotArea');
      for (let step = 0; step < 12 && document.activeElement !== plot; step++) await userEvent.tab();

      expect(plot, `on ${version}`).toHaveFocus();
      view.unmount();
    }
  });
});

describe('colour rules', () => {
  const rules = (...rules: Array<{ filter: string; colour: string }>) =>
    server.use(http.get('/api/colour-rules', () => HttpResponse.json({ rules })));

  // The topic is drawn a segment at a time, so it is found by the row's whole text, not a word.
  // The topic line itself is what a rule paints now, so it is both the handle and the subject.
  const topicOf = (topic: string) =>
    screen.getAllByTestId('topic').find((row) => row.textContent === topic)!;

  it('marks an entry whose topic a rule covers', async () => {
    rules({ filter: 'sensors/+/temp', colour: '#b45309' });
    useSelectionStore.getState().select(chip);
    received('sensors/a/temp');

    render(<Monitor />);

    await waitFor(() => expect(topicOf('sensors/a/temp')).toHaveStyle({ color: '#b45309' }));
  });

  it('leaves an entry no rule covers unmarked, but still drawn', async () => {
    rules({ filter: 'sensors/+/temp', colour: '#b45309' });
    useSelectionStore.getState().select(chip);
    received('sensors/a/temp', 'sensors/a/hum');

    render(<Monitor />);
    await userEvent.click(screen.getByRole('button', { name: '2 in history' }));

    await waitFor(() => expect(topicOf('sensors/a/temp')).toHaveStyle({ color: '#b45309' }));
    expect(topicOf('sensors/a/hum').style.color).toBe('');
  });

  it('gives an entry the colour of the most specific rule that covers it', async () => {
    rules({ filter: 'sensors/#', colour: '#111111' }, { filter: 'sensors/+/temp', colour: '#222222' });
    useSelectionStore.getState().select(chip);
    received('sensors/a/temp');

    render(<Monitor />);

    await waitFor(() => expect(topicOf('sensors/a/temp')).toHaveStyle({ color: '#222222' }));
  });

  it('carries on drawing the log when the rules cannot be fetched', async () => {
    server.use(http.get('/api/colour-rules', () => new HttpResponse(null, { status: 500 })));
    useSelectionStore.getState().select(chip);
    received('sensors/a/temp');

    render(<Monitor />);

    expect(screen.getByTestId('entry')).toBeInTheDocument();
    await waitFor(() => expect(topicOf('sensors/a/temp').style.color).toBe(''));
  });
});

// The entry's left edge is its kind — ink for a message that arrived. A rule that covers the
// topic takes that edge over, so a run of entries reads by rule at a glance.
describe('the entry wears its rule on the left edge', () => {
  const rules = (...rules: Array<{ filter: string; colour: string }>) =>
    server.use(http.get('/api/colour-rules', () => HttpResponse.json({ rules })));

  const edgeOf = (topic: string) => {
    const entry = screen
      .getAllByTestId('entry')
      .find((row) => within(row).getByTestId('topic').textContent === topic);

    return (entry as HTMLElement).style.getPropertyValue('--rule-colour');
  };

  it('hands the rule colour to the entry it covers', async () => {
    rules({ filter: 'sensors/+/temp', colour: '#b45309' });
    useSelectionStore.getState().select(chip);
    received('sensors/a/temp');

    render(<Monitor />);

    await waitFor(() => expect(edgeOf('sensors/a/temp')).toBe('#b45309'));
  });

  it('leaves an entry no rule covers on its own kind colour', async () => {
    rules({ filter: 'sensors/+/temp', colour: '#b45309' });
    useSelectionStore.getState().select(chip);
    received('sensors/a/temp', 'sensors/a/hum');

    render(<Monitor />);
    await userEvent.click(screen.getByRole('button', { name: '2 in history' }));

    await waitFor(() => expect(edgeOf('sensors/a/temp')).toBe('#b45309'));
    expect(edgeOf('sensors/a/hum')).toBe('');
  });
});

// The head and the stamps are the entry's quiet furniture: what arrived, when, at what QoS and
// size. They read as one faint black voice, and a colour rule does not reach them — the topic
// beneath them is what wears the colour.
describe('the head and the stamps stay quiet', () => {
  const rules = (...rules: Array<{ filter: string; colour: string }>) =>
    server.use(http.get('/api/colour-rules', () => HttpResponse.json({ rules })));

  it('leaves the head alone when a rule covers the topic', async () => {
    rules({ filter: 'sensors/+/temp', colour: '#b45309' });
    useSelectionStore.getState().select(chip);
    useLogStore.getState().push({ kind: 'recv', topic: 'sensors/a/temp', stamps: ['QoS 1'] });

    render(<Monitor />);

    await waitFor(() => expect(screen.getByTestId('topic')).toHaveStyle({ color: '#b45309' }));
    expect(screen.getByText('QoS 1').style.color).toBe('');
  });

  it('gives a retained message no colour of its own', () => {
    useLogStore.getState().push({
      kind: 'recv',
      topic: 'sensors/a/temp',
      stamps: ['QoS 1', 'RETAINED', '4B'],
    });
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    // Same treatment as the QoS and size beside it; only the word tells them apart.
    const colourOf = (text: string) => getComputedStyle(screen.getByText(text)).color;

    expect(colourOf('RETAINED')).toBe(colourOf('QoS 1'));
    expect(colourOf('RETAINED')).toBe(colourOf('4B'));
  });

  // Every row in the pane arrived, so a mark saying so on each of them marked nothing. What the
  // head carries now is the time and the stamps, and no direction at all.
  it('draws no direction mark on an arrival', () => {
    received('sensors/a/temp');
    useSelectionStore.getState().select(chip);

    render(<Monitor />);

    expect(screen.queryByTestId('verb')).not.toBeInTheDocument();
    expect(screen.getByTestId('head')).not.toHaveTextContent('↓');
  });
});
