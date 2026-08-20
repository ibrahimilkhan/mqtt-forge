import { act, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderWithClient as render } from '../../test/renderWithClient';
import { useAppearanceStore } from '../../stores/appearanceStore';
import { useLogStore } from '../../stores/logStore';
import { useSelectionStore } from '../../stores/selectionStore';
import { ChartWindows } from './ChartWindows';
import { TrafficPane } from './TrafficPane';
import { useChartWindows } from './useChartWindows';
import { useHoldStore } from './useTraffic';
import { useZoomStore } from './useZoom';

/** The pane and the windows pinned off it, which is how the app puts them on screen. */
const Console = () => (
  <>
    <TrafficPane />
    <ChartWindows />
  </>
);

const readings = (topic: string, ...bodies: string[]) =>
  bodies.forEach((body) => useLogStore.getState().push({ kind: 'recv', topic, body }));

const kiln = { label: 'sensors/kiln', filter: 'sensors/kiln' };
const room = { label: 'sensors/room', filter: 'sensors/room' };

// jsdom knows nothing about pointer capture, and a drag is a capture.
function capturing() {
  const held = {
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    hasPointerCapture: () => true,
  };
  for (const [name, value] of Object.entries(held)) {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, value });
  }

  return () => {
    for (const name of Object.keys(held)) Reflect.deleteProperty(HTMLElement.prototype, name);
  };
}

/** A grab, a move and a release — the move only lands on the next animation frame. */
async function drag(handle: HTMLElement, dx: number, dy: number) {
  fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 100 + dx, clientY: 100 + dy });
  await act(() => new Promise((frame) => requestAnimationFrame(() => frame(undefined))));
  fireEvent.pointerUp(handle, { pointerId: 1 });
}

const openAndPin = async () => {
  await userEvent.click(screen.getByTestId('zoom'));
  await userEvent.click(screen.getByRole('button', { name: /^Pin / }));
};

/** A window opens pinned in place; taking the pin out is what lets it be moved. */
const unpin = async (label: string) =>
  userEvent.click(screen.getByRole('button', { name: `Let ${label} move` }));

beforeEach(() => {
  useLogStore.getState().clear();
  useSelectionStore.getState().clear();
  useHoldStore.getState().release();
  useZoomStore.setState({ zoomed: false, box: null });
  useChartWindows.setState({ windows: [] });
  useAppearanceStore.getState().reset();
});

afterEach(() => useChartWindows.setState({ windows: [] }));

describe('pinning a chart', () => {
  // The whole point: two runs on screen at once, rather than one run and the memory of another.
  it('goes on drawing the topic it was pinned on after the console has moved elsewhere', async () => {
    readings('sensors/kiln', '900', '910', '920');
    readings('sensors/room', '21', '22', '23');
    useSelectionStore.getState().select(kiln);

    render(<Console />);
    await openAndPin();

    act(() => useSelectionStore.getState().select(room));

    const window_ = screen.getByTestId('chart-window');
    expect(window_).toHaveAttribute('data-filter', 'sensors/kiln');
    expect(window_).toHaveAccessibleName('sensors/kiln chart');
    // And the console's own chart has followed the selection, as it always did.
    expect(useSelectionStore.getState().selected?.filter).toBe('sensors/room');
  });

  it('puts the thrown-open chart away, so the same run is not drawn twice', async () => {
    readings('sensors/kiln', '900', '910');
    useSelectionStore.getState().select(kiln);

    render(<Console />);
    await openAndPin();

    expect(useZoomStore.getState().zoomed).toBe(false);
    expect(screen.getByTestId('chart-window')).toBeInTheDocument();
  });

  // Every one of these is the first one, as far as where it starts is concerned: not stepped
  // clear of the last — that gave a reader pinning four of them a staircase — and not inherited
  // from a window that had been dragged and sized somewhere else since.
  it('opens each new window in the middle, wherever the last one ended up', async () => {
    readings('sensors/kiln', '900', '910');
    readings('sensors/room', '21', '22');
    useSelectionStore.getState().select(kiln);

    render(<Console />);
    await openAndPin();

    const opened = { ...useChartWindows.getState().windows[0].box };
    // The first one is dragged off into a corner and made small.
    act(() =>
      useChartWindows
        .getState()
        .place(useChartWindows.getState().windows[0].id, { x: 0, y: 0, w: 320, h: 240 }),
    );

    act(() => useSelectionStore.getState().select(room));
    await openAndPin();

    expect(useChartWindows.getState().windows[1].box).toEqual(opened);
    const [, second] = screen.getAllByTestId('chart-window');
    // And the newest is the one on top, so it is not hidden behind what it landed on.
    expect(second).toHaveAttribute('data-filter', 'sensors/room');
  });

  // One window on the last ten minutes and another on the whole history, or the same run in two
  // ranges side by side: a rule against this would be the tool deciding what is being compared.
  it('opens as many windows on one topic as it is asked for', async () => {
    readings('sensors/kiln', '900', '910');
    useSelectionStore.getState().select(kiln);

    render(<Console />);
    await openAndPin();
    await openAndPin();

    expect(screen.getAllByTestId('chart-window')).toHaveLength(2);
  });

  // The window opens where the chart it was pinned from was standing, at the same size — so the
  // far end of its bar is exactly where the pin that made it was a moment ago. A second press
  // there, the one that asks 'did that work?', used to let the window straight back go.
  it('keeps the control that lets it go clear of the one that made it', async () => {
    readings('sensors/kiln', '900', '910');
    useSelectionStore.getState().select(kiln);

    render(<Console />);
    await openAndPin();

    const bar = screen.getByTitle('Pinned in place — unpin to move it');
    expect(bar.firstElementChild).toHaveAttribute('aria-label', 'Let sensors/kiln move');
  });

  it('closes the window when its close is pressed', async () => {
    readings('sensors/kiln', '900', '910');
    useSelectionStore.getState().select(kiln);

    render(<Console />);
    await openAndPin();
    await userEvent.click(screen.getByRole('button', { name: 'Close the sensors/kiln chart' }));

    expect(screen.queryByTestId('chart-window')).not.toBeInTheDocument();
  });

  // The pin is what holds a window still, not what holds it open. Pressing it used to close the
  // window, which is a different promise from the one a pin makes anywhere else.
  it('leaves the window standing when the pin comes out', async () => {
    readings('sensors/kiln', '900', '910');
    useSelectionStore.getState().select(kiln);

    render(<Console />);
    await openAndPin();
    await userEvent.click(screen.getByRole('button', { name: 'Let sensors/kiln move' }));

    expect(screen.getByTestId('chart-window')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pin sensors/kiln in place' })).toBeInTheDocument();
  });

  it('says so when the topic it holds has nothing to chart', async () => {
    readings('sensors/kiln', '900', '910');
    useSelectionStore.getState().select(kiln);

    render(<Console />);
    await openAndPin();
    act(() => useLogStore.getState().clear());

    // Inside the window: the console's own pane is still on this topic and says the same thing.
    expect(
      within(screen.getByTestId('chart-window')).getByText('Nothing on sensors/kiln to chart yet.'),
    ).toBeInTheDocument();
  });
});

describe('placing a window', () => {
  // Opening one is a deliberate act, and a chart that slid under the next drag would undo it.
  it('holds its place while it is pinned, and offers no corner to size it by', async () => {
    readings('sensors/kiln', '900', '910');
    useSelectionStore.getState().select(kiln);
    const done = capturing();

    render(<Console />);
    await openAndPin();

    const window_ = screen.getByTestId('chart-window');
    const from = { left: window_.style.left, top: window_.style.top };
    await drag(screen.getByTitle('Pinned in place — unpin to move it'), 60, 60);

    expect(window_.style.left).toBe(from.left);
    expect(window_.style.top).toBe(from.top);
    expect(screen.queryByRole('button', { name: /^Resize / })).not.toBeInTheDocument();
    done();
  });

  it('comes forward when it is touched, pinned or not', async () => {
    readings('sensors/kiln', '900', '910');
    readings('sensors/room', '21', '22');
    useSelectionStore.getState().select(kiln);

    render(<Console />);
    await openAndPin();
    act(() => useSelectionStore.getState().select(room));
    await openAndPin();

    fireEvent.pointerDown(screen.getByLabelText('sensors/kiln chart'), { pointerId: 1 });

    expect(screen.getAllByTestId('chart-window').at(-1)).toHaveAttribute('data-filter', 'sensors/kiln');
  });

  it('moves with the bar it is dragged by', async () => {
    readings('sensors/kiln', '900', '910');
    useSelectionStore.getState().select(kiln);
    const done = capturing();

    render(<Console />);
    await openAndPin();
    await unpin('sensors/kiln');

    const window_ = screen.getByTestId('chart-window');
    const from = { left: window_.style.left, top: window_.style.top };
    await drag(screen.getByTitle('Drag to move — the corner sizes it'), 40, 30);

    expect(window_.style.left).toBe(`${parseInt(from.left, 10) + 40}px`);
    expect(window_.style.top).toBe(`${parseInt(from.top, 10) + 30}px`);
    done();
  });

  it('sizes with the corner it is dragged by', async () => {
    readings('sensors/kiln', '900', '910');
    useSelectionStore.getState().select(kiln);
    const done = capturing();

    render(<Console />);
    await openAndPin();
    await unpin('sensors/kiln');

    const window_ = screen.getByTestId('chart-window');
    const was = parseInt(window_.style.width, 10);
    await drag(screen.getByRole('button', { name: 'Resize the sensors/kiln chart' }), 60, 40);

    expect(parseInt(window_.style.width, 10)).toBe(was + 60);
    done();
  });

  // A window that can only be placed with a pointer is a window some readers cannot place.
  it('sizes with the arrow keys as well', async () => {
    readings('sensors/kiln', '900', '910');
    useSelectionStore.getState().select(kiln);

    render(<Console />);
    await openAndPin();
    await unpin('sensors/kiln');

    const window_ = screen.getByTestId('chart-window');
    const was = parseInt(window_.style.width, 10);
    screen.getByRole('button', { name: 'Resize the sensors/kiln chart' }).focus();
    await userEvent.keyboard('{ArrowRight}');

    expect(parseInt(window_.style.width, 10)).toBeGreaterThan(was);
  });

  // The bar is the only way to bring a window back, so a viewport that shrank out from under one
  // must not be able to take its bar with it.
  it('walks a window back inside when the viewport shrinks under it', async () => {
    readings('sensors/kiln', '900', '910');
    useSelectionStore.getState().select(kiln);

    render(<Console />);
    await openAndPin();

    const window_ = screen.getByTestId('chart-window');
    act(() => {
      useChartWindows.getState().place(useChartWindows.getState().windows[0].id, {
        x: 900,
        y: 600,
        w: 400,
        h: 300,
      });
    });
    expect(window_.style.left).toBe('900px');

    act(() => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 600 });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 400 });
      window.dispatchEvent(new Event('resize'));
    });

    expect(parseInt(window_.style.left, 10)).toBeLessThanOrEqual(600 - 64);
    expect(parseInt(window_.style.top, 10)).toBeLessThanOrEqual(400 - 64);
  });

  // Reaching into a window behind another one should bring it forward before the press lands.
  it('brings the window that is reached into to the front', async () => {
    readings('sensors/kiln', '900', '910');
    readings('sensors/room', '21', '22');
    useSelectionStore.getState().select(kiln);

    render(<Console />);
    await openAndPin();
    act(() => useSelectionStore.getState().select(room));
    await openAndPin();

    // Drawn back to front, so the last one is the one on top.
    expect(screen.getAllByTestId('chart-window').at(-1)).toHaveAttribute('data-filter', 'sensors/room');

    fireEvent.pointerDown(screen.getByLabelText('sensors/kiln chart'), { pointerId: 1 });

    expect(screen.getAllByTestId('chart-window').at(-1)).toHaveAttribute('data-filter', 'sensors/kiln');
  });
});
