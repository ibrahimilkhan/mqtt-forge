import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
// The log reads its colour rules through react-query, so every render here needs a client.
import { renderWithClient as render } from '../../test/renderWithClient';
import { server } from '../../test/server';
import { byteLength } from '../../lib/payload';
import type { DecodedMessage } from '../../realtime/decodeIncoming';
import { useComposeStore } from '../../stores/composeStore';
import { MAX_LOG_ENTRIES, useLogStore } from '../../stores/logStore';
import { useSelectionStore } from '../../stores/selectionStore';
import { WireLog } from './WireLog';

const chip = { label: 'sensors/#', filter: 'sensors/#' };

// Oldest first, so the newest lands at the head of the store.
const received = (...topics: string[]) =>
  topics.forEach((topic) => useLogStore.getState().push({ kind: 'recv', verb: 'Received', topic }));

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
});

describe('WireLog', () => {
  it('asks for a topic while nothing is selected', () => {
    received('sensors/room/temp');

    render(<WireLog />);

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

    render(<WireLog />);

    expect(screen.queryByText(/No traffic on/)).not.toBeInTheDocument();
    expect(screen.getByTestId('topic')).toHaveTextContent('sensors/attic/temp');
  });

  it('says the selected topic is quiet when nothing has matched it yet', () => {
    received('actuators/valve');
    useSelectionStore.getState().select(chip);

    render(<WireLog />);

    expect(screen.getByText('No traffic on sensors/# yet.')).toBeInTheDocument();
  });

  it('keeps only the entries matching the selected filter', () => {
    received('sensors/room/temp', 'actuators/valve', 'sensors/hall/temp');
    useSelectionStore.getState().select(chip);

    render(<WireLog />);

    const topics = screen.getAllByTestId('topic').map((topic) => topic.textContent);
    expect(topics).toEqual(['sensors/hall/temp', 'sensors/room/temp']);
  });

  it('shows the command entries for the topic alongside its messages', () => {
    useLogStore.getState().push({ kind: 'ok', verb: 'Subscribed', topic: 'sensors/#' });
    received('sensors/room/temp');
    useSelectionStore.getState().select(chip);

    render(<WireLog />);

    const verbs = screen.getAllByTestId('entry').map((entry) => within(entry).getByTestId('verb').textContent);
    expect(verbs).toEqual(['Received', 'Subscribed']);
  });

  it('stops at five entries and offers the rest', () => {
    received(...Array.from({ length: 8 }, (_, i) => `sensors/${i}`));
    useSelectionStore.getState().select(chip);

    render(<WireLog />);

    expect(screen.getAllByTestId('entry')).toHaveLength(5);
    expect(screen.getByRole('button', { name: 'Show 3 more' })).toBeInTheDocument();
  });

  it('reveals the rest on demand and folds them back', async () => {
    received(...Array.from({ length: 8 }, (_, i) => `sensors/${i}`));
    useSelectionStore.getState().select(chip);

    render(<WireLog />);
    await userEvent.click(screen.getByRole('button', { name: 'Show 3 more' }));

    expect(screen.getAllByTestId('entry')).toHaveLength(8);

    await userEvent.click(screen.getByRole('button', { name: 'Show fewer' }));

    expect(screen.getAllByTestId('entry')).toHaveLength(5);
  });

  it('leaves the button off when five entries cover everything', () => {
    received('sensors/a', 'sensors/b');
    useSelectionStore.getState().select(chip);

    render(<WireLog />);

    expect(screen.queryByRole('button', { name: /Show/ })).not.toBeInTheDocument();
  });

  it('folds the list back up when the selection changes', async () => {
    received(...Array.from({ length: 8 }, (_, i) => `sensors/${i}`));
    received(...Array.from({ length: 8 }, (_, i) => `actuators/${i}`));
    useSelectionStore.getState().select(chip);

    render(<WireLog />);
    await userEvent.click(screen.getByRole('button', { name: 'Show 3 more' }));
    act(() => useSelectionStore.getState().select({ label: 'actuators', filter: 'actuators/#' }));

    expect(screen.getAllByTestId('entry')).toHaveLength(5);
  });

  it('names the selected topic and can drop it', async () => {
    received('sensors/room/temp');
    useSelectionStore.getState().select(chip);

    render(<WireLog />);
    expect(screen.getByTestId('focus')).toHaveTextContent('sensors/#');

    await userEvent.click(screen.getByRole('button', { name: 'Clear topic selection' }));

    expect(useSelectionStore.getState().selected).toBeNull();
  });

  it('splits the topic on slashes so the separators can be dimmed', () => {
    received('sensors/room/temp');
    useSelectionStore.getState().select(chip);

    render(<WireLog />);

    const topic = screen.getByTestId('topic');
    expect(topic).toHaveTextContent('sensors/room/temp');
    expect(within(topic).getAllByTestId('sep')).toHaveLength(2);
  });

  it('shows the stamps and the body', () => {
    useLogStore.getState().push({
      kind: 'recv',
      verb: 'Received',
      topic: 'sensors/room/temp',
      body: '21.5',
      stamps: ['QoS 1', 'RETAINED', '4 B'],
    });
    useSelectionStore.getState().select(chip);

    render(<WireLog />);

    expect(screen.getByText('QoS 1')).toBeInTheDocument();
    expect(screen.getByText('RETAINED')).toBeInTheDocument();
    expect(screen.getByText('4 B')).toBeInTheDocument();
    expect(screen.getByText('21.5')).toBeInTheDocument();
  });

  it('names each stamp so retained messages can be coloured apart', () => {
    useLogStore.getState().push({
      kind: 'recv',
      verb: 'Received',
      topic: 'sensors/room/temp',
      stamps: ['QoS 1', 'RETAINED'],
    });
    useSelectionStore.getState().select(chip);

    render(<WireLog />);

    expect(screen.getByText('RETAINED')).toHaveAttribute('data-stamp', 'RETAINED');
  });

  it('marks each entry with its kind, which drives the colour', () => {
    useLogStore.getState().push({ kind: 'fault', verb: 'Publish failed', topic: 'sensors/room/temp' });
    useSelectionStore.getState().select(chip);

    render(<WireLog />);

    expect(screen.getByTestId('entry')).toHaveAttribute('data-kind', 'fault');
  });

  it('sends a logged message back to publish, settings and all', async () => {
    useLogStore.getState().push({
      kind: 'recv',
      verb: 'Received',
      topic: 'sensors/temp',
      body: '21.5',
      qos: 2,
      retain: true,
    });
    useSelectionStore.getState().select(chip);
    render(<WireLog />);

    await userEvent.click(screen.getByRole('button', { name: 'Load sensors/temp into publish' }));

    expect(useComposeStore.getState().draft).toMatchObject({
      topic: 'sensors/temp',
      payload: '21.5',
      qos: 2,
      retain: true,
    });
  });

  // A command entry's topic is the filter it was aimed at, and its body is an outcome, not a
  // payload. Neither can be published, so the row is not a target.
  it('leaves the command entries out of the load-into-publish affordance', () => {
    useLogStore.getState().push({ kind: 'ok', verb: 'Subscribed', topic: 'sensors/#' });
    useLogStore
      .getState()
      .push({ kind: 'fault', verb: 'Subscribe failed', topic: 'sensors/#', body: 'Not connected.' });
    useSelectionStore.getState().select(chip);

    render(<WireLog />);

    expect(screen.queryByRole('button', { name: /into publish/ })).not.toBeInTheDocument();
  });

  it('holds off loading when the click is the end of a text selection', () => {
    useLogStore.getState().push({ kind: 'recv', verb: 'Received', topic: 'sensors/temp', body: '21.5' });
    useSelectionStore.getState().select(chip);

    render(<WireLog />);

    const body = screen.getByText('21.5');
    const range = document.createRange();
    range.selectNodeContents(body);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.click(body);

    expect(useComposeStore.getState().draft).toBeNull();
  });
});

describe('colour rules', () => {
  const rules = (...rules: Array<{ filter: string; colour: string }>) =>
    server.use(http.get('/api/colour-rules', () => HttpResponse.json({ rules })));

  // The topic is drawn a segment at a time, so it is found by the row's whole text, not a word.
  const dotOf = (topic: string) => {
    const entry = screen
      .getAllByTestId('entry')
      .find((row) => within(row).getByTestId('topic').textContent === topic);

    return within(entry!).getByTestId('dot');
  };

  it('marks an entry whose topic a rule covers', async () => {
    rules({ filter: 'sensors/+/temp', colour: '#b45309' });
    useSelectionStore.getState().select(chip);
    received('sensors/a/temp');

    render(<WireLog />);

    await waitFor(() => expect(dotOf('sensors/a/temp')).toHaveStyle({ background: '#b45309' }));
  });

  it('leaves an entry no rule covers unmarked, but still drawn', async () => {
    rules({ filter: 'sensors/+/temp', colour: '#b45309' });
    useSelectionStore.getState().select(chip);
    received('sensors/a/temp', 'sensors/a/hum');

    render(<WireLog />);

    await waitFor(() => expect(dotOf('sensors/a/temp')).toHaveStyle({ background: '#b45309' }));
    expect(dotOf('sensors/a/hum')).toHaveStyle({ background: 'transparent' });
  });

  it('gives an entry the colour of the most specific rule that covers it', async () => {
    rules({ filter: 'sensors/#', colour: '#111111' }, { filter: 'sensors/+/temp', colour: '#222222' });
    useSelectionStore.getState().select(chip);
    received('sensors/a/temp');

    render(<WireLog />);

    await waitFor(() => expect(dotOf('sensors/a/temp')).toHaveStyle({ background: '#222222' }));
  });

  // Command entries carry a filter, not a topic; a wildcard is not a thing a rule can colour.
  it('leaves a command entry unmarked', async () => {
    rules({ filter: 'sensors/#', colour: '#111111' });
    useSelectionStore.getState().select(chip);
    useLogStore.getState().push({ kind: 'ok', verb: 'Subscribed', topic: 'sensors/#' });

    render(<WireLog />);

    await waitFor(() => expect(screen.getByTestId('entry')).toBeInTheDocument());
    expect(within(screen.getByTestId('entry')).getByTestId('dot')).toHaveStyle({
      background: 'transparent',
    });
  });

  it('carries on drawing the log when the rules cannot be fetched', async () => {
    server.use(http.get('/api/colour-rules', () => new HttpResponse(null, { status: 500 })));
    useSelectionStore.getState().select(chip);
    received('sensors/a/temp');

    render(<WireLog />);

    expect(screen.getByTestId('entry')).toBeInTheDocument();
    await waitFor(() => expect(dotOf('sensors/a/temp')).toHaveStyle({ background: 'transparent' }));
  });
});
