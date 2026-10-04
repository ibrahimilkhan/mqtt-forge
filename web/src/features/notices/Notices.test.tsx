import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOTICE_MS, useNoticeStore } from '../../stores/noticeStore';
import type { FlowNoticeDto } from '../../types/api';
import { Notices } from './Notices';

const notice = (over: Partial<FlowNoticeDto> = {}): FlowNoticeDto => ({
  flowId: 'watch', flowName: 'Boiler watch', nodeId: 'tell', text: 'k1 is hot', level: 'critical',
  at: '2026-10-03T09:00:00Z', test: false, ...over,
});

/** The stack, found the way a screen reader finds it: by what it is and by its name. */
const stack = () => screen.getByRole('log', { name: 'Notices' });

describe('notices', () => {
  beforeEach(() => useNoticeStore.setState(useNoticeStore.getInitialState()));
  afterEach(() => vi.useRealTimers());

  // A log, and not a status like the health line's: a status is read whole each time it changes,
  // and a log is read by what is added to it, so a notice coming in is told on its own and not
  // together with the three still standing beside it.
  it('says which flow said what, and in a live region a screen reader reads', () => {
    render(<Notices />);
    act(() => useNoticeStore.getState().add([notice()]));

    expect(stack()).toHaveAttribute('aria-live', 'polite');
    expect(stack()).toContainElement(screen.getByText('k1 is hot'));
    expect(stack()).toContainElement(screen.getByText('Boiler watch'));
  });

  it('marks what a test said as a test', () => {
    render(<Notices />);
    act(() => useNoticeStore.getState().add([notice({ test: true })]));

    expect(screen.getByText(/test/i)).toBeInTheDocument();
  });

  // The chip is for the notices a test made. One on every notice would mark none of them.
  it('does not mark what a flow that is running said as a test', () => {
    render(<Notices />);
    act(() => useNoticeStore.getState().add([notice({ test: false })]));

    expect(screen.getByText('k1 is hot')).toBeInTheDocument();
    expect(screen.queryByText(/test/i)).not.toBeInTheDocument();
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

    await userEvent.click(screen.getByRole('button', { name: 'Close notice from Boiler watch: k1 is hot' }));

    expect(screen.queryByText('k1 is hot')).not.toBeInTheDocument();
  });

  // Four stand at once, and four buttons that all say Close are four a reader has to tell apart by
  // where they happen to be. Each says whose notice it closes, and what it says — one flow says one
  // notice for each sensor that runs hot — and closes that one only.
  it('names each Close for the flow that said the notice and for what it says, and closes that notice alone', async () => {
    render(<Notices />);
    act(() =>
      useNoticeStore.getState().add([
        notice({ text: 'k1 is hot' }),
        notice({ text: 'k2 is hot' }),
        notice({ flowId: 'kiln', flowName: 'Kiln line', text: 'the door is open' }),
      ]),
    );

    expect(screen.getAllByRole('button').map((close) => close.getAttribute('aria-label'))).toEqual([
      'Close notice from Kiln line: the door is open',
      'Close notice from Boiler watch: k2 is hot',
      'Close notice from Boiler watch: k1 is hot',
    ]);

    await userEvent.click(screen.getByRole('button', { name: 'Close notice from Boiler watch: k2 is hot' }));

    expect(screen.queryByText('k2 is hot')).not.toBeInTheDocument();
    expect(screen.getByText('k1 is hot')).toBeInTheDocument();
    expect(screen.getByText('the door is open')).toBeInTheDocument();
  });

  // A screen reader goes through a notice in the order it is written: what it says, and then the
  // way to be rid of it. A Close that came first would be the first thing said of every notice.
  it('puts the way to close a notice after what it says', () => {
    render(<Notices />);
    act(() => useNoticeStore.getState().add([notice()]));

    const says = screen.getByText('k1 is hot');
    const close = screen.getByRole('button', { name: 'Close notice from Boiler watch: k1 is hot' });

    expect(says.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

  // The level is said in a word, which is the first signal, and drawn in a colour, which is the
  // second — the console's rule for a level, as in the alert wall's rows. A screen reader has no
  // colours and a forced-colours window has lost them, and a reader who cannot tell these three
  // apart has not got them either; all three still have the word. The colour is the card's
  // `data-level`, which the stylesheet draws the edge and the word by, and jsdom lays nothing out,
  // so that is the hook this holds it to.
  it('stacks the newest on top, each saying its level in a word', () => {
    render(<Notices />);
    act(() => useNoticeStore.getState().add([notice({ text: 'first', level: 'info' })]));
    act(() => useNoticeStore.getState().add([notice({ text: 'second', level: 'warn' })]));
    act(() => useNoticeStore.getState().add([notice({ text: 'third', level: 'critical' })]));

    const cards = Array.from(stack().children) as HTMLElement[];
    const [third, second, first] = cards;
    expect(third).toHaveTextContent('third');
    expect(within(third).getByText('critical')).toBeInTheDocument();
    expect(second).toHaveTextContent('second');
    expect(within(second).getByText('warn')).toBeInTheDocument();
    expect(first).toHaveTextContent('first');
    expect(within(first).getByText('info')).toBeInTheDocument();
    expect(cards.map((card) => card.getAttribute('data-level'))).toEqual(['critical', 'warn', 'info']);
  });

  // A live region has to be in the page before something is put in it, or the first notice is added
  // along with the region and is not read out.
  it('stands in the page with nothing in it, so the first notice is read out', () => {
    render(<Notices />);

    expect(stack()).toHaveAttribute('aria-live', 'polite');
  });

  // The word is the first thing a screen reader says of a notice, and the first thing in its card.
  it('says the level before anything else in the card', () => {
    render(<Notices />);
    act(() => useNoticeStore.getState().add([notice({ test: true })]));

    expect(stack().children[0].textContent).toMatch(/^critical/);
  });
});

/**
 * A notice is held while the reader is at it, with the pointer or the keyboard: one that went from
 * under the pointer, or took the keyboard with it, was gone before it was read, and left the reader
 * at the top of the document.
 */
describe('a notice the reader is at', () => {
  beforeEach(() => useNoticeStore.setState(useNoticeStore.getInitialState()));
  afterEach(() => vi.useRealTimers());

  const close = (text: string) => screen.getByRole('button', { name: `Close notice from Boiler watch: ${text}` });

  it('stays while the keyboard is in it, and goes eight seconds after the keyboard leaves', () => {
    vi.useFakeTimers();
    render(
      <>
        <button type="button">Elsewhere</button>
        <Notices />
      </>,
    );
    act(() => useNoticeStore.getState().add([notice()]));

    act(() => close('k1 is hot').focus());
    act(() => vi.advanceTimersByTime(NOTICE_MS));
    expect(screen.getByText('k1 is hot')).toBeInTheDocument();

    act(() => screen.getByRole('button', { name: 'Elsewhere' }).focus());
    act(() => vi.advanceTimersByTime(NOTICE_MS - 1));
    expect(screen.getByText('k1 is hot')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText('k1 is hot')).not.toBeInTheDocument();
  });

  it('stays while the pointer is on it, and goes eight seconds after the pointer leaves', () => {
    vi.useFakeTimers();
    render(<Notices />);
    act(() => useNoticeStore.getState().add([notice()]));
    const card = stack().children[0];

    fireEvent.mouseEnter(card);
    act(() => vi.advanceTimersByTime(NOTICE_MS));
    expect(screen.getByText('k1 is hot')).toBeInTheDocument();

    fireEvent.mouseLeave(card);
    act(() => vi.advanceTimersByTime(NOTICE_MS - 1));
    expect(screen.getByText('k1 is hot')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText('k1 is hot')).not.toBeInTheDocument();
  });

  it('puts the keyboard on the next Close when a notice is closed from it, and back where it came from when the last goes', async () => {
    render(
      <>
        <button type="button">Elsewhere</button>
        <Notices />
      </>,
    );
    act(() => useNoticeStore.getState().add([notice({ text: 'k1 is hot' }), notice({ text: 'k2 is hot' })]));
    screen.getByRole('button', { name: 'Elsewhere' }).focus();

    await userEvent.tab();
    expect(document.activeElement).toBe(close('k2 is hot'));
    await userEvent.keyboard('{Enter}');

    expect(screen.queryByText('k2 is hot')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(close('k1 is hot'));
    await userEvent.keyboard('{Enter}');

    expect(screen.queryByText('k1 is hot')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Elsewhere' }));
  });

  // A fifth notice pushes the one that has stood longest out of the stack, keyboard or none.
  it('puts the keyboard on the Close before it when a new notice pushes out the one it was on', () => {
    render(<Notices />);
    act(() => useNoticeStore.getState().add(['k1', 'k2', 'k3', 'k4'].map((sensor) => notice({ text: `${sensor} is hot` }))));
    act(() => close('k1 is hot').focus());

    act(() => useNoticeStore.getState().add([notice({ text: 'k5 is hot' })]));

    expect(screen.queryByText('k1 is hot')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(close('k2 is hot'));
  });
});
