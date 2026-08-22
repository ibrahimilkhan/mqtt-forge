import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient as render } from '../../test/renderWithClient';
import { usePauseStore } from '../../stores/pauseStore';
import { StreamPause } from './StreamPause';

beforeEach(() => usePauseStore.setState({ paused: false, waiting: 0, lost: 0 }));

describe('stopping the console taking messages', () => {
  // Nothing is arriving without a broker, so there is nothing for this to stop.
  describe('with no broker on the other end', () => {
    it('is out of reach', () => {
      render(<StreamPause />);

      expect(screen.getByRole('button')).toBeDisabled();
    });

    it('leaves the flow alone when it is pressed anyway', async () => {
      render(<StreamPause />);
      await userEvent.click(screen.getByRole('button'));

      expect(usePauseStore.getState().paused).toBe(false);
    });

    // Otherwise a console whose broker dropped while it was held would have no way back, and
    // would go on ignoring the traffic once the link returned.
    it('still offers the way back when it was stopped before the link went', () => {
      usePauseStore.setState({ paused: true });
      render(<StreamPause />);

      expect(screen.getByRole('button', { name: 'Take messages again' })).toBeEnabled();
    });
  });

  it('offers to stop while it is running', () => {
    render(<StreamPause live />);

    expect(screen.getByRole('button', { name: 'Stop taking messages' })).toBeInTheDocument();
  });

  // At the foot of the rail it has the width for words, and a red box with two bars in it is a
  // pause symbol only to a reader who already knows the symbol.
  it('says what pressing it does', () => {
    render(<StreamPause live />);

    expect(screen.getByRole('button', { name: 'Stop taking messages' })).toHaveTextContent(
      'Stop stream',
    );
  });

  it('drops the words with the rail, keeping them on the element', () => {
    render(<StreamPause compact live />);

    const button = screen.getByRole('button');
    expect(button.textContent).toBe('');
    expect(button).toHaveAccessibleName('Stop taking messages');
  });

  it('stops the flow when it is pressed', async () => {
    render(<StreamPause live />);
    await userEvent.click(screen.getByRole('button', { name: 'Stop taking messages' }));

    expect(usePauseStore.getState().paused).toBe(true);
  });

  it('offers the way back once it is stopped', async () => {
    render(<StreamPause live />);
    await userEvent.click(screen.getByRole('button', { name: 'Stop taking messages' }));

    expect(screen.getByRole('button', { name: 'Take messages again' })).toBeInTheDocument();
  });

  it('starts the flow again, leaving the queue to drain', async () => {
    render(<StreamPause live />);
    await userEvent.click(screen.getByRole('button', { name: 'Stop taking messages' }));
    act(() => usePauseStore.getState().track(40));
    await userEvent.click(screen.getByRole('button', { name: /Take messages again/ }));

    expect(usePauseStore.getState().paused).toBe(false);
    // Not cleared here: the queue is the bridge's, and the number falls as it lands.
    expect(usePauseStore.getState().waiting).toBe(40);
  });

  // Nothing is thrown away, so the figure is what is still to come rather than what was missed.
  describe('the queue behind it', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('is counted and said out loud', async () => {
      render(<StreamPause live />);
      act(() => usePauseStore.setState({ paused: true }));
      act(() => usePauseStore.getState().track(1200));
      act(() => void vi.advanceTimersByTime(500));

      expect(
        screen.getByRole('button', { name: 'Take messages again, 1200 waiting' }),
      ).toHaveTextContent('1.2k');
    });

    it('is left off while nothing is waiting, leaving the control saying only what it does', () => {
      render(<StreamPause live />);
      act(() => usePauseStore.setState({ paused: true }));
      act(() => void vi.advanceTimersByTime(500));

      expect(screen.getByRole('button').textContent).toBe('Resume');
    });

    // Shut, the rail is 52px and the glyph is the whole control.
    it('is said but not shown when the rail is shut', () => {
      render(<StreamPause compact live />);
      act(() => usePauseStore.setState({ paused: true }));
      act(() => usePauseStore.getState().track(40));
      act(() => void vi.advanceTimersByTime(500));

      const button = screen.getByRole('button');
      expect(button.textContent).toBe('');
      expect(button).toHaveAccessibleName('Take messages again, 40 waiting');
    });

    // The drain is the half a reader has never been shown before: the console is running again
    // and the figure counts down to nothing as what it held lands.
    it('goes on saying how much is left after the flow is let go', () => {
      render(<StreamPause live />);
      act(() => usePauseStore.setState({ paused: true }));
      act(() => usePauseStore.getState().track(2400));
      act(() => void vi.advanceTimersByTime(500));

      // Let go, so the console is running again — and the figure is now what is still to land
      // rather than what is being held back.
      act(() => usePauseStore.getState().toggle());

      expect(screen.getByRole('button', { name: 'Stop taking messages' })).toHaveTextContent(
        'Stop stream2.4k',
      );

      act(() => usePauseStore.getState().track(0));
      act(() => void vi.advanceTimersByTime(500));

      expect(screen.getByRole('button', { name: 'Stop taking messages' })).toHaveTextContent(
        'Stop stream',
      );
    });
  });
});
