import { render, screen } from '@testing-library/react';
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

  it('hides children until the branch is opened', async () => {
    useTopicTreeStore.getState().apply([message('sensors/temp', '21.5')]);
    render(<TopicTree />);

    expect(screen.queryByText('temp')).not.toBeInTheDocument();
    await userEvent.click(screen.getByText('sensors'));

    expect(screen.getByText('temp')).toBeInTheDocument();
  });

  it('summarises a branch and shows the payload on a leaf', async () => {
    useTopicTreeStore.getState().apply([message('sensors/temp', '21.5'), message('sensors/humidity', '54')]);
    render(<TopicTree />);

    expect(screen.getByText('2 topics · 2 messages')).toBeInTheDocument();
    await userEvent.click(screen.getByText('sensors'));

    expect(screen.getByText('21.5')).toBeInTheDocument();
  });

  it('opens every branch at once, including ones that arrive later', async () => {
    useTopicTreeStore.getState().apply([message('a/x')]);
    render(<TopicTree />);

    await userEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    useTopicTreeStore.getState().apply([message('b/y')]);

    expect(await screen.findByText('x')).toBeInTheDocument();
    expect(await screen.findByText('y')).toBeInTheDocument();
  });

  it('collapses every branch', async () => {
    useTopicTreeStore.getState().apply([message('a/x')]);
    render(<TopicTree />);

    await userEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    await userEvent.click(screen.getByRole('button', { name: 'Collapse all' }));

    expect(screen.queryByText('x')).not.toBeInTheDocument();
  });
});
