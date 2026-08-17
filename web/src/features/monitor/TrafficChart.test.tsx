import { screen } from '@testing-library/react';
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

    expect(screen.getByTestId('note').textContent).toContain('silent');
  });

  // Held, the newest reading on show gets older by the second while the topic may be publishing
  // perfectly well behind the hold. An alarm then would be an alarm about the reader's own hand.
  it('raises no alarm about silence while the pane is being held still', () => {
    render(<TrafficChart entries={run(60_000)} frozen />);

    expect(screen.getByTestId('note').textContent).not.toContain('silent');
  });

  it('still charts the run it was given while held', () => {
    render(<TrafficChart entries={run(60_000)} frozen />);

    expect(screen.getByTestId('plot')).toBeInTheDocument();
  });
});
