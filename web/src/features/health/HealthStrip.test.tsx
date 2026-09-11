import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { byteLength } from '../../lib/payload';
import type { DecodedMessage } from '../../realtime/decodeIncoming';
import { useHealthStore } from '../../stores/healthStore';
import { useLogStore } from '../../stores/logStore';
import { useTopicTreeStore } from '../../stores/topicTreeStore';
import { HealthStrip } from './HealthStrip';

const message = (topic: string, payload: string): DecodedMessage => ({
  topic,
  payload,
  mode: 'text',
  size: byteLength(payload),
  qos: 0,
  retain: false,
  receivedAt: '2026-08-22T17:00:00Z',
});

const send = (...messages: DecodedMessage[]) => {
  useLogStore.getState().appendReceived(messages);
  useTopicTreeStore.getState().apply(messages);
};

/** One reading is taken a second; this is that second passing. */
const aSecond = () => act(() => void vi.advanceTimersByTime(1000));

beforeEach(() => {
  vi.useFakeTimers();
  useLogStore.getState().clear();
  useTopicTreeStore.getState().reset();
  useHealthStore.setState({ arrived: 0, spentMs: 0 });
});

afterEach(() => vi.useRealTimers());

describe('what the console is carrying', () => {
  it('says it is measuring until the first reading is in', () => {
    render(<HealthStrip />);

    expect(screen.getByText('measuring…')).toBeInTheDocument();
  });

  // One message on one topic is the ordinary state a second after a connection comes up, and the
  // strip read '1 on 1 topics' through all of it.
  it('earns the s on the topics it is spread over', () => {
    send(message('plant/one', '21'));
    render(<HealthStrip />);
    aSecond();

    expect(screen.getByText('1 on 1 topic')).toBeInTheDocument();

    send(message('plant/two', '22'));
    aSecond();

    expect(screen.getByText('2 on 2 topics')).toBeInTheDocument();
  });

  it('counts what the log holds and what it is spread over', () => {
    send(message('plant/one', '21'), message('plant/two', '22'), message('plant/one', '23'));
    render(<HealthStrip />);
    aSecond();

    expect(screen.getByText('3 on 2 topics')).toBeInTheDocument();
  });

  it('weighs the bodies it is holding', () => {
    send(message('plant/one', 'x'.repeat(2048)));
    render(<HealthStrip />);
    aSecond();

    expect(screen.getByText('2 kB')).toBeInTheDocument();
  });

  // The rate is what explains every other number on the line.
  it('says how much arrived in the second it is reporting on', () => {
    render(<HealthStrip />);
    act(() => useHealthStore.getState().took(400, 1.5));
    aSecond();

    expect(screen.getByText('400/s')).toBeInTheDocument();
  });

  it('starts each second over rather than adding to the last', () => {
    render(<HealthStrip />);
    act(() => useHealthStore.getState().took(400, 1.5));
    aSecond();
    aSecond();

    expect(screen.getByText('0/s')).toBeInTheDocument();
  });

  // Taking messages in is a fraction of the cost of drawing them, and a line that reported only
  // the first would say a console was idle while it stuttered.
  it('reports what taking them cost apart from what drawing them does', () => {
    render(<HealthStrip />);
    act(() => useHealthStore.getState().took(400, 2.4));
    aSecond();

    expect(screen.getByText('2.4 ms/s')).toBeInTheDocument();
    expect(screen.getByText(/fps$/)).toBeInTheDocument();
  });

  it('counts a crowded broker in thousands rather than in full', () => {
    send(...Array.from({ length: 1500 }, (_, i) => message(`crowd/${i}`, '.')));
    render(<HealthStrip />);
    aSecond();

    expect(screen.getByText('1.5k on 1.5k topics')).toBeInTheDocument();
  });
});
