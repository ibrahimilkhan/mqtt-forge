import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { useLogStore } from '../../stores/logStore';
import { useSelectionStore } from '../../stores/selectionStore';
import { WireLog } from './WireLog';

const chip = { label: 'sensors/#', filter: 'sensors/#' };

// Oldest first, so the newest lands at the head of the store.
const received = (...topics: string[]) =>
  topics.forEach((topic) => useLogStore.getState().push({ kind: 'recv', verb: 'Received', topic }));

beforeEach(() => {
  useLogStore.getState().clear();
  useSelectionStore.getState().clear();
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
});
