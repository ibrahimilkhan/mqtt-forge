import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectedFor } from './ConnectedFor';

const NOW = new Date('2026-08-08T12:00:00Z');

const agoBy = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => vi.useRealTimers());

describe('ConnectedFor', () => {
  it('counts in seconds for the first minute', () => {
    render(<ConnectedFor since={agoBy(5_000)} />);

    expect(screen.getByText(/· 5 sec$/)).toBeInTheDocument();
  });

  it('counts in whole minutes for the first hour', () => {
    render(<ConnectedFor since={agoBy(12 * 60_000 + 40_000)} />);

    expect(screen.getByText(/· 12 min$/)).toBeInTheDocument();
  });

  it('counts in hours and minutes beyond an hour', () => {
    render(<ConnectedFor since={agoBy(72 * 60_000)} />);

    expect(screen.getByText(/· 1 hr 12 min$/)).toBeInTheDocument();
  });

  it('keeps counting on its own', () => {
    render(<ConnectedFor since={agoBy(0)} />);
    expect(screen.getByText(/· 0 sec$/)).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(3_000);
    });

    expect(screen.getByText(/· 3 sec$/)).toBeInTheDocument();
  });

  it('shows the wall-clock time the link came up', () => {
    render(<ConnectedFor since={agoBy(0)} />);

    expect(screen.getByText(/^\d{2}:\d{2}:\d{2} · /)).toBeInTheDocument();
  });

  it('stops counting once it is gone', () => {
    const { unmount } = render(<ConnectedFor since={agoBy(0)} />);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});
