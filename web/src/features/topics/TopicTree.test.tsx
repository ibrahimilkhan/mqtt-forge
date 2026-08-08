import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_TREE_ROWS } from '../../lib/topicTree';
import { useSelectionStore } from '../../stores/selectionStore';
import { useTopicTreeStore } from '../../stores/topicTreeStore';
import type { MqttMessage } from '../../types/api';
import { ACTIVE_WINDOW_MS, TopicTree } from './TopicTree';

const message = (topic: string, payload = '1'): MqttMessage => ({
  topic,
  payload,
  qos: 0,
  retain: false,
  receivedAt: '2026-07-26T10:00:00Z',
});

beforeEach(() => {
  useTopicTreeStore.setState({ defaultOpen: false });
  useTopicTreeStore.getState().reset();
  useSelectionStore.getState().clear();
});

describe('TopicTree', () => {
  it('explains itself while empty', () => {
    render(<TopicTree />);

    expect(
      screen.getByText('No topics yet. Connect to a broker and its tree builds here.'),
    ).toBeInTheDocument();
  });

  const branchOf = (name: string) => screen.getByText(name).closest('[data-open]');

  it('keeps a branch closed until it is opened', async () => {
    useTopicTreeStore.getState().apply([message('sensors/temp', '21.5')]);
    render(<TopicTree />);

    expect(branchOf('sensors')).toHaveAttribute('data-open', 'false');
    await userEvent.click(screen.getByRole('button', { name: 'Expand sensors' }));

    expect(branchOf('sensors')).toHaveAttribute('data-open', 'true');
    expect(screen.getByText('temp')).toBeInTheDocument();
  });

  // The whole point of the flattening: a broker with 20k topics must not put 20k rows in the DOM.
  it('leaves the rows beneath a closed branch out of the document', () => {
    useTopicTreeStore.getState().apply([message('sensors/temp', '21.5')]);
    render(<TopicTree />);

    expect(screen.queryByText('temp')).not.toBeInTheDocument();
  });

  it('drops the rows again when the branch is collapsed', async () => {
    useTopicTreeStore.getState().apply([message('sensors/temp', '21.5')]);
    render(<TopicTree />);

    await userEvent.click(screen.getByRole('button', { name: 'Expand sensors' }));
    await userEvent.click(screen.getByRole('button', { name: 'Collapse sensors' }));

    expect(screen.queryByText('temp')).not.toBeInTheDocument();
  });

  it('stops drawing past its row ceiling and says how many it held back', () => {
    const topics = Array.from({ length: MAX_TREE_ROWS + 3 }, (_, i) => message(`t${i}`));
    useTopicTreeStore.getState().apply(topics);
    render(<TopicTree />);

    expect(screen.getByText('3 more topics not shown')).toBeInTheDocument();
  });

  it('summarises a branch and shows the payload on a leaf', async () => {
    useTopicTreeStore.getState().apply([message('sensors/temp', '21.5'), message('sensors/humidity', '54')]);
    render(<TopicTree />);

    expect(screen.getByText('2 topics')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Expand sensors' }));
    expect(screen.getByText('21.5')).toBeInTheDocument();
  });

  it('opens every branch at once, including ones that arrive later', async () => {
    useTopicTreeStore.getState().apply([message('a/x')]);
    render(<TopicTree />);

    await userEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    useTopicTreeStore.getState().apply([message('b/y')]);

    await waitFor(() => expect(branchOf('a')).toHaveAttribute('data-open', 'true'));
    expect(branchOf('b')).toHaveAttribute('data-open', 'true');
  });

  // Traffic reads as a steady tint on the row, held while messages keep coming.
  const rowOf = (name: string) => screen.getByText(name).closest('[data-branch]');

  it('tints a closed branch when a message lands on something beneath it', () => {
    useTopicTreeStore.getState().apply([message('sensors/temp', '1')]);
    render(<TopicTree />);

    expect(rowOf('sensors')).toHaveAttribute('data-active', 'true');
  });

  it('leaves an open branch untinted when the message was for a descendant', async () => {
    useTopicTreeStore.getState().apply([message('sensors/temp', '1')]);
    render(<TopicTree />);
    await userEvent.click(screen.getByRole('button', { name: 'Expand sensors' }));

    expect(rowOf('temp')).toHaveAttribute('data-active', 'true');
    expect(rowOf('sensors')).toHaveAttribute('data-active', 'false');
  });

  it('tints an open branch when the message was addressed to it', async () => {
    useTopicTreeStore.getState().apply([message('sensors/temp', '1'), message('sensors', 'own')]);
    render(<TopicTree />);
    await userEvent.click(screen.getByRole('button', { name: 'Expand sensors' }));

    expect(rowOf('sensors')).toHaveAttribute('data-active', 'true');
  });

  // The point of the change: a row under constant traffic holds one colour instead of
  // restarting a fade per message, which was what made a busy broker strobe.
  it('holds the tint through a second message rather than restarting anything', () => {
    useTopicTreeStore.getState().apply([message('sensors/temp', '1')]);
    render(<TopicTree />);
    const row = rowOf('sensors');

    useTopicTreeStore.getState().apply([message('sensors/temp', '2')]);

    expect(rowOf('sensors')).toBe(row);
    expect(rowOf('sensors')).toHaveAttribute('data-active', 'true');
  });

  it('drops the tint once the topic falls quiet', async () => {
    vi.useFakeTimers();
    try {
      useTopicTreeStore.getState().apply([message('sensors/temp', '1')]);
      render(<TopicTree />);
      expect(rowOf('sensors')).toHaveAttribute('data-active', 'true');

      await act(async () => {
        vi.advanceTimersByTime(ACTIVE_WINDOW_MS + 50);
      });

      expect(rowOf('sensors')).toHaveAttribute('data-active', 'false');
    } finally {
      vi.useRealTimers();
    }
  });

  it('has no fade animation left to stack up', () => {
    useTopicTreeStore.getState().apply([message('sensors/temp', '1')]);
    render(<TopicTree />);

    expect(getComputedStyle(rowOf('sensors')!).animationName).toBe('none');
  });

  it('focuses the wire log on the clicked node and everything beneath it', async () => {
    useTopicTreeStore.getState().apply([message('sensors/temp', '21.5')]);
    render(<TopicTree />);

    await userEvent.click(screen.getByText('sensors'));

    expect(useSelectionStore.getState().selected).toEqual({ label: 'sensors', filter: 'sensors/#' });
  });

  it('focuses a leaf on its own full path', async () => {
    useTopicTreeStore.getState().apply([message('sensors/temp', '21.5')]);
    render(<TopicTree />);
    await userEvent.click(screen.getByRole('button', { name: 'Expand sensors' }));

    await userEvent.click(screen.getByText('temp'));

    expect(useSelectionStore.getState().selected).toEqual({
      label: 'sensors/temp',
      filter: 'sensors/temp/#',
    });
  });

  it('leaves the branch closed when the row is clicked', async () => {
    useTopicTreeStore.getState().apply([message('sensors/temp', '21.5')]);
    render(<TopicTree />);

    await userEvent.click(screen.getByText('sensors'));

    expect(branchOf('sensors')).toHaveAttribute('data-open', 'false');
  });

  it('drops the focus when the selected node is clicked again', async () => {
    useTopicTreeStore.getState().apply([message('sensors/temp', '21.5')]);
    render(<TopicTree />);

    await userEvent.click(screen.getByText('sensors'));
    await userEvent.click(screen.getByText('sensors'));

    expect(useSelectionStore.getState().selected).toBeNull();
  });

  it('marks the focused row', async () => {
    useTopicTreeStore.getState().apply([message('sensors/temp', '21.5')]);
    render(<TopicTree />);

    await userEvent.click(screen.getByText('sensors'));

    expect(screen.getByText('sensors').closest('[data-branch]')).toHaveAttribute('data-selected', 'true');
  });

  it('collapses every branch', async () => {
    useTopicTreeStore.getState().apply([message('a/x')]);
    render(<TopicTree />);

    await userEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    await userEvent.click(screen.getByRole('button', { name: 'Collapse all' }));

    expect(branchOf('a')).toHaveAttribute('data-open', 'false');
  });

  // Already safe: synchronous store writes, no network call, so no guard needed here.
  it('settles on a consistent state when the twisty is clicked rapidly with no waits', () => {
    useTopicTreeStore.getState().apply([message('sensors/temp')]);
    render(<TopicTree />);
    const twisty = screen.getByRole('button', { name: 'Expand sensors' });

    fireEvent.click(twisty);
    fireEvent.click(twisty);
    fireEvent.click(twisty);

    expect(branchOf('sensors')).toHaveAttribute('data-open', 'true');
  });

  it('settles on a consistent state when expand/collapse all are hammered with no waits', () => {
    useTopicTreeStore.getState().apply([message('a/x')]);
    render(<TopicTree />);

    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));

    expect(branchOf('a')).toHaveAttribute('data-open', 'true');
  });
});
