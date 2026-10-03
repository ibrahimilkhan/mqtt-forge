import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOTICE_MS, useNoticeStore } from '../../stores/noticeStore';
import type { FlowNoticeDto } from '../../types/api';
import { Notices } from './Notices';

const notice = (over: Partial<FlowNoticeDto> = {}): FlowNoticeDto => ({
  flowId: 'watch', flowName: 'Boiler watch', nodeId: 'tell', text: 'k1 is hot', level: 'critical',
  at: '2026-10-03T09:00:00Z', test: false, ...over,
});

describe('notices', () => {
  beforeEach(() => useNoticeStore.setState(useNoticeStore.getInitialState()));
  afterEach(() => vi.useRealTimers());

  it('says which flow said what, and in a live region a screen reader reads', () => {
    render(<Notices />);
    act(() => useNoticeStore.getState().add([notice()]));

    const shown = screen.getByText('k1 is hot');
    expect(shown.closest('[aria-live="polite"]')).not.toBeNull();
    expect(screen.getByText('Boiler watch')).toBeInTheDocument();
  });

  it('marks what a test said as a test', () => {
    render(<Notices />);
    act(() => useNoticeStore.getState().add([notice({ test: true })]));

    expect(screen.getByText(/test/i)).toBeInTheDocument();
  });

  it('goes by itself after eight seconds', () => {
    vi.useFakeTimers();
    render(<Notices />);
    act(() => useNoticeStore.getState().add([notice()]));

    act(() => vi.advanceTimersByTime(NOTICE_MS - 1));
    expect(screen.getByText('k1 is hot')).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText('k1 is hot')).not.toBeInTheDocument();
  });

  it('can be closed before then', async () => {
    render(<Notices />);
    act(() => useNoticeStore.getState().add([notice()]));

    await userEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(screen.queryByText('k1 is hot')).not.toBeInTheDocument();
  });

  // Eight seconds each, and not eight for the stack: a notice that came three seconds after another
  // stands for its own eight, and an arrival must not start the ones already standing again.
  it('counts each notice its own eight seconds from when it came', () => {
    vi.useFakeTimers();
    render(<Notices />);
    act(() => useNoticeStore.getState().add([notice({ text: 'first' })]));
    act(() => vi.advanceTimersByTime(3_000));
    act(() => useNoticeStore.getState().add([notice({ text: 'second' })]));

    act(() => vi.advanceTimersByTime(NOTICE_MS - 3_000));
    expect(screen.queryByText('first')).not.toBeInTheDocument();
    expect(screen.getByText('second')).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(3_000));
    expect(screen.queryByText('second')).not.toBeInTheDocument();
  });

  it('stacks the newest on top, each carrying its level for the stylesheet to colour it by', () => {
    render(<Notices />);
    act(() => useNoticeStore.getState().add([notice({ text: 'older', level: 'info' })]));
    act(() => useNoticeStore.getState().add([notice({ text: 'newer', level: 'critical' })]));

    const cards = screen.getByLabelText('Notices').children;
    expect(Array.from(cards, (card) => card.getAttribute('data-level'))).toEqual(['critical', 'info']);
    expect(cards[0]).toHaveTextContent('newer');
    expect(cards[1]).toHaveTextContent('older');
  });

  // A live region has to be in the page before something is put in it, or the first notice is added
  // along with the region and is not read out.
  it('stands in the page with nothing in it, so the first notice is read out', () => {
    render(<Notices />);

    expect(screen.getByLabelText('Notices')).toHaveAttribute('aria-live', 'polite');
  });
});
