import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderWithClient as render } from '../../test/renderWithClient';
import { useAppearanceStore } from '../../stores/appearanceStore';
import { runsOf, type LogEntry } from '../../stores/logStore';
import { TrafficChart } from './TrafficChart';

// The chart takes one run per topic now. These tests still build a selection as one sequence,
// which is how a reader thinks of it, and this is the grouping the log itself does.
const asRuns = (entries: LogEntry[]) => runsOf(entries);

let nextId = 0;

// Newest first, the order the log holds them in, ending however long ago the caller says.
const run = (endedAgo: number, count = 8): LogEntry[] =>
  Array.from({ length: count }, (_, i) => ({
    id: nextId++,
    kind: 'recv' as const,
    at: new Date(Date.now() - endedAgo - i * 1000),
    topic: 'sensors/temp',
    body: `${20 + (i % 3)}`,
  }));

beforeEach(() => {
  useAppearanceStore.getState().reset();
});

describe('TrafficChart', () => {
  it('marks a topic with a rhythm as silent once it falls behind it', () => {
    render(<TrafficChart runs={asRuns(run(60_000))} />);

    expect(screen.getByTestId('reading-silence').textContent).not.toBe('—');
  });

  // Held, the newest reading on show gets older by the second while the topic may be publishing
  // perfectly well behind the hold. An alarm then would be an alarm about the reader's own hand.
  it('raises no alarm about silence while the pane is being held still', () => {
    render(<TrafficChart runs={asRuns(run(60_000))} frozen />);

    expect(screen.getByTestId('reading-silence').textContent).toBe('—');
  });

  it('still charts the run it was given while held', () => {
    render(<TrafficChart runs={asRuns(run(60_000))} frozen />);

    expect(screen.getByTestId('plot')).toBeInTheDocument();
  });
});

// Found by review, with a repro: every message on a topic carries some fields and only the
// newest carry others, so picking one of the rarer fields takes the run down to what carries it.
// A reading opened at an index past the end of that shorter run was read for its value without
// asking, and the pane — and the console around it — went white.
describe('a run that gets shorter under an opened reading', () => {
  let id = 0;
  const mixed = (): LogEntry[] =>
    Array.from({ length: 30 }, (_, i) => ({
      id: id++,
      kind: 'recv' as const,
      at: new Date(Date.parse('2026-08-21T00:00:00Z') - i * 1000),
      topic: 'sensors/env',
      // Every message carries `a`; only the newest three carry `b`.
      body: i < 3 ? JSON.stringify({ a: 20 + i, b: 5 + i }) : JSON.stringify({ a: 20 + i }),
    }));

  it('closes the reading rather than taking the pane down with it', async () => {
    render(<TrafficChart runs={asRuns(mixed())} />);

    screen.getByTestId('plotArea').focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByTestId('detail')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Chart b' }));

    expect(screen.getByTestId('plot')).toBeInTheDocument();
    expect(screen.queryByTestId('detail')).not.toBeInTheDocument();
  });
});

/**
 * A device that reports its whole configuration in one message.
 *
 * The complaint this answers: forty chips reading `broker.session.expiryInterval` are the chart
 * region full of somebody else's field names, with the chart itself pushed off the bottom of it.
 */
describe('a body with its numbers nested', () => {
  let id = 0;
  const nested = (): LogEntry[] =>
    Array.from({ length: 20 }, (_, i) => ({
      id: id++,
      kind: 'recv' as const,
      at: new Date(Date.parse('2026-08-21T00:00:00Z') - i * 1000),
      topic: 'devices/gateway',
      body: JSON.stringify({
        uptime: 900 + i,
        broker: { port: 1883, session: { expiryInterval: 3600 + i } },
      }),
    }));

  it('offers the top of the body rather than every path in it', async () => {
    render(<TrafficChart runs={asRuns(nested())} />);

    expect(screen.getByRole('button', { name: 'Chart uptime' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open broker' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Chart broker.session.expiryInterval' }),
    ).not.toBeInTheDocument();
  });

  it('opens a group onto what is under it, and comes back out again', async () => {
    render(<TrafficChart runs={asRuns(nested())} />);

    await userEvent.click(screen.getByRole('button', { name: 'Open broker' }));

    expect(screen.getByRole('button', { name: 'Chart broker.port' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open broker.session' })).toBeInTheDocument();
    // The way in is gone while you are in it, and the way out names where you are standing.
    expect(screen.queryByRole('button', { name: 'Chart uptime' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Back out of broker' }));

    expect(screen.getByRole('button', { name: 'Chart uptime' })).toBeInTheDocument();
  });

  it('walks down as far as the fields go', async () => {
    render(<TrafficChart runs={asRuns(nested())} />);

    await userEvent.click(screen.getByRole('button', { name: 'Open broker' }));
    await userEvent.click(screen.getByRole('button', { name: 'Open broker.session' }));

    expect(
      screen.getByRole('button', { name: 'Chart broker.session.expiryInterval' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back out of broker.session' })).toBeInTheDocument();
  });

  // The chips are a way in rather than a reading, and a way in that stays open has become
  // furniture. What is left behind names what is charted, so nothing the row said is lost.
  it('puts the chips away, and keeps the one that says what is drawn', async () => {
    render(<TrafficChart runs={asRuns(nested())} />);

    await userEvent.click(screen.getByRole('button', { name: 'Chart uptime' }));
    await userEvent.click(screen.getByRole('button', { name: 'Put the field chips away' }));

    expect(screen.queryByRole('button', { name: 'Open broker' })).not.toBeInTheDocument();
    // A label rather than a control: the way back is the mark beside it, and the word 'hide'
    // standing at the end of a row of field names read as one more field.
    expect(screen.getByTestId('chart')).toHaveTextContent('uptime');
    const back = screen.getByRole('button', { name: 'Show the field chips' });
    expect(back).toHaveTextContent('');

    await userEvent.click(back);

    expect(screen.getByRole('button', { name: 'Open broker' })).toBeInTheDocument();
  });
});
