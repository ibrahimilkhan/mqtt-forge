import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
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
    await userEvent.click(screen.getByText('sensors'));

    expect(branchOf('sensors')).toHaveAttribute('data-open', 'true');
    expect(screen.getByText('temp')).toBeInTheDocument();
  });

  it('summarises a branch and shows the payload on a leaf', async () => {
    useTopicTreeStore.getState().apply([message('sensors/temp', '21.5'), message('sensors/humidity', '54')]);
    render(<TopicTree />);

    expect(screen.getByText('2 topics · 2 messages')).toBeInTheDocument();
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
    await userEvent.click(screen.getByText('sensors'));
    const branchRow = rowKeyOf('sensors');
    const leafRow = rowKeyOf('temp');

    useTopicTreeStore.getState().apply([message('sensors/temp', '2')]);

    await waitFor(() => expect(rowKeyOf('temp')).not.toBe(leafRow));
    expect(rowKeyOf('sensors')).toBe(branchRow);
  });

  it('flashes an open branch when the message was addressed to it', async () => {
    useTopicTreeStore.getState().apply([message('sensors/temp', '1'), message('sensors', 'own')]);
    render(<TopicTree />);
    await userEvent.click(screen.getByText('sensors'));
    const branchRow = rowKeyOf('sensors');

    useTopicTreeStore.getState().apply([message('sensors', 'own again')]);

    await waitFor(() => expect(rowKeyOf('sensors')).not.toBe(branchRow));
  });

  it('collapses every branch', async () => {
    useTopicTreeStore.getState().apply([message('a/x')]);
    render(<TopicTree />);

    await userEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    await userEvent.click(screen.getByRole('button', { name: 'Collapse all' }));

    expect(branchOf('a')).toHaveAttribute('data-open', 'false');
  });
});
