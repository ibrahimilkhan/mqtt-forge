import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { useSelectionStore } from '../../stores/selectionStore';
import { useTopicTreeStore } from '../../stores/topicTreeStore';
import type { MqttMessage } from '../../types/api';
import { TopicTree } from './TopicTree';

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

  // Children stay mounted while a branch is closed, so the assertion is on the branch's
  // own state rather than on the presence of its rows.
  const branchOf = (name: string) => screen.getByText(name).closest('[data-open]');

  it('keeps a branch closed until it is opened', async () => {
    useTopicTreeStore.getState().apply([message('sensors/temp', '21.5')]);
    render(<TopicTree />);

    expect(branchOf('sensors')).toHaveAttribute('data-open', 'false');
    await userEvent.click(screen.getByRole('button', { name: 'Expand sensors' }));

    expect(branchOf('sensors')).toHaveAttribute('data-open', 'true');
    expect(screen.getByText('temp')).toBeInTheDocument();
  });

  it('summarises a branch and shows the payload on a leaf', async () => {
    useTopicTreeStore.getState().apply([message('sensors/temp', '21.5'), message('sensors/humidity', '54')]);
    render(<TopicTree />);

    expect(screen.getByText('2 topics')).toBeInTheDocument();
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

  // The flash is a CSS animation restarted by remounting the row, so "does it flash" is
  // "did the row's key change". These pin which row answers for a message.
  const rowKeyOf = (name: string) => screen.getByText(name).closest('[data-branch]');

  it('flashes a closed branch when a message lands on something beneath it', async () => {
    useTopicTreeStore.getState().apply([message('sensors/temp', '1')]);
    render(<TopicTree />);
    const before = rowKeyOf('sensors');

    useTopicTreeStore.getState().apply([message('sensors/temp', '2')]);

    await waitFor(() => expect(rowKeyOf('sensors')).not.toBe(before));
  });

  it('leaves an open branch alone when the message was for a descendant', async () => {
    useTopicTreeStore.getState().apply([message('sensors/temp', '1')]);
    render(<TopicTree />);
    await userEvent.click(screen.getByRole('button', { name: 'Expand sensors' }));
    const branchRow = rowKeyOf('sensors');
    const leafRow = rowKeyOf('temp');

    useTopicTreeStore.getState().apply([message('sensors/temp', '2')]);

    await waitFor(() => expect(rowKeyOf('temp')).not.toBe(leafRow));
    expect(rowKeyOf('sensors')).toBe(branchRow);
  });

  it('flashes an open branch when the message was addressed to it', async () => {
    useTopicTreeStore.getState().apply([message('sensors/temp', '1'), message('sensors', 'own')]);
    render(<TopicTree />);
    await userEvent.click(screen.getByRole('button', { name: 'Expand sensors' }));
    const branchRow = rowKeyOf('sensors');

    useTopicTreeStore.getState().apply([message('sensors', 'own again')]);

    await waitFor(() => expect(rowKeyOf('sensors')).not.toBe(branchRow));
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

  // Already safe: toggle/setAllOpen/select are synchronous store writes with no network
  // call, so firing them back to back without waiting cannot leave a stale in-flight
  // request or an inconsistent server/UI state - only the ordinary last-write-wins result.
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
