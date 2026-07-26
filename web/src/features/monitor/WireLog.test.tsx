import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useLogStore } from '../../stores/logStore';
import { WireLog } from './WireLog';

beforeEach(() => useLogStore.getState().clear());

describe('WireLog', () => {
  it('invites the user to connect while it is empty', () => {
    render(<WireLog />);

    expect(
      screen.getByText('Nothing on the wire yet. Connect to a broker, then publish a message.'),
    ).toBeInTheDocument();
  });

  it('renders the newest entry first', () => {
    useLogStore.getState().push({ kind: 'ok', verb: 'Connected' });
    useLogStore.getState().push({ kind: 'ok', verb: 'Subscribed' });

    render(<WireLog />);

    const verbs = screen.getAllByTestId('entry').map((entry) => within(entry).getByTestId('verb').textContent);
    expect(verbs).toEqual(['Subscribed', 'Connected']);
  });

  it('splits the topic on slashes so the separators can be dimmed', () => {
    useLogStore.getState().push({ kind: 'recv', verb: 'Received', topic: 'sensors/room/temp' });

    render(<WireLog />);

    const topic = screen.getByTestId('topic');
    expect(topic).toHaveTextContent('sensors/room/temp');
    expect(within(topic).getAllByTestId('sep')).toHaveLength(2);
  });

  it('shows the stamps and the body', () => {
    useLogStore
      .getState()
      .push({ kind: 'recv', verb: 'Received', topic: 'a', body: '21.5', stamps: ['QoS 1', 'RETAINED'] });

    render(<WireLog />);

    expect(screen.getByText('QoS 1')).toBeInTheDocument();
    expect(screen.getByText('RETAINED')).toBeInTheDocument();
    expect(screen.getByText('21.5')).toBeInTheDocument();
  });

  it('marks each entry with its kind, which drives the colour', () => {
    useLogStore.getState().push({ kind: 'fault', verb: 'Publish failed' });

    render(<WireLog />);

    expect(screen.getByTestId('entry')).toHaveAttribute('data-kind', 'fault');
  });
});
