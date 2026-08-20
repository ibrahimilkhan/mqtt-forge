import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderWithClient as render } from '../../test/renderWithClient';
import { useAppearanceStore } from '../../stores/appearanceStore';
import type { LogEntry } from '../../stores/logStore';
import { TrafficChart } from './TrafficChart';

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
    render(<TrafficChart entries={run(60_000)} />);

    expect(screen.getByTestId('reading-silence').textContent).not.toBe('—');
  });

  // Held, the newest reading on show gets older by the second while the topic may be publishing
  // perfectly well behind the hold. An alarm then would be an alarm about the reader's own hand.
  it('raises no alarm about silence while the pane is being held still', () => {
    render(<TrafficChart entries={run(60_000)} frozen />);

    expect(screen.getByTestId('reading-silence').textContent).toBe('—');
  });

  it('still charts the run it was given while held', () => {
    render(<TrafficChart entries={run(60_000)} frozen />);

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
    render(<TrafficChart entries={mixed()} />);

    screen.getByTestId('plotArea').focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByTestId('detail')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Chart b' }));

    expect(screen.getByTestId('plot')).toBeInTheDocument();
    expect(screen.queryByTestId('detail')).not.toBeInTheDocument();
  });
});
