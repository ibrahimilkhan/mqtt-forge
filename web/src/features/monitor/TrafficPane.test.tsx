import { act, cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient as render } from '../../test/renderWithClient';
import { useAppearanceStore } from '../../stores/appearanceStore';
import { useLogStore } from '../../stores/logStore';
import { useSelectionStore } from '../../stores/selectionStore';
import { READING_IDS, READINGS } from '../appearance/readings';
import { TrafficPane } from './TrafficPane';
import { useHoldStore } from './useTraffic';
import { useZoomStore } from './useZoom';

const chip = { label: 'sensors/#', filter: 'sensors/#' };

/** Oldest first, so the newest lands at the head of the store. */
const readings = (topic: string, ...bodies: string[]) =>
  bodies.forEach((body) => useLogStore.getState().push({ kind: 'recv', topic, body }));

const reading = (slot: string) => screen.getByTestId(`reading-${slot}`).textContent;

const repeat = (times: number, ...pattern: string[]) =>
  Array.from({ length: times * pattern.length }, (_, i) => pattern[i % pattern.length]);

/** A run with a swing and a little noise on it — an ordinary quantity. */
const wobble = (n: number, base: number, swing: number) =>
  Array.from({ length: n }, (_, i) =>
    (base + Math.sin(i / 4) * swing + ((i * 37) % 11) / 40).toFixed(2),
  );

beforeEach(() => {
  useLogStore.getState().clear();
  useSelectionStore.getState().clear();
  useHoldStore.getState().release();
  useZoomStore.getState().close();
  useAppearanceStore.getState().reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const show = () => {
  useSelectionStore.getState().select(chip);
  render(<TrafficPane />);
};

describe('the range the plot is drawn in', () => {
  // The brief's own run: a topic that reads 1, 2, 3 all day and once reads 4000. On the extremes
  // the thousand readings someone came for share the bottom pixel of the pane.
  const spiked = [...repeat(10, '1', '2', '3'), '4000'];

  it('spends the height on where the readings mostly are, and pins the spike to the edge', () => {
    readings('sensors/temp', ...spiked);
    show();

    expect(screen.getByTestId('scale').textContent).toContain('↑1');
    expect(screen.getByTestId('pinned')).toBeInTheDocument();
  });

  it('says in the note how many readings the plot could not hold', () => {
    readings('sensors/temp', ...spiked);
    show();

    expect(reading('off scale')).toBe('↑1');
  });

  // A range that quietly clipped the reading someone is hunting for would be worse than an
  // unreadable one, so the way back to the whole run is one chip away.
  it('draws every reading once the reader asks for the extremes', async () => {
    readings('sensors/temp', ...spiked);
    show();

    await userEvent.click(screen.getByRole('button', { name: /Extremes/ }));

    expect(screen.queryByTestId('pinned')).not.toBeInTheDocument();
    expect(screen.getByTestId('scale').textContent).toContain('4000');
  });

  it('follows the range set in the settings when the reader has not asked for one', () => {
    useAppearanceStore.getState().setScale('extremes');
    readings('sensors/temp', ...spiked);
    show();

    expect(screen.queryByTestId('pinned')).not.toBeInTheDocument();
  });
});

describe('throwing the chart open', () => {
  const run = () => readings('sensors/temp', ...wobble(30, 21.5, 1.5));

  it('opens over the console and goes back again', async () => {
    run();
    show();

    await userEvent.click(screen.getByRole('button', { name: 'Open the chart over the console' }));
    expect(useZoomStore.getState().zoomed).toBe(true);

    await userEvent.click(screen.getByRole('button', { name: 'Put the chart back' }));
    expect(useZoomStore.getState().zoomed).toBe(false);
  });

  // Anything covering the whole window has to close on Escape, or a reader who did it by
  // accident is hunting for the control that undoes it.
  it('goes back on Escape', async () => {
    run();
    show();

    await userEvent.click(screen.getByRole('button', { name: 'Open the chart over the console' }));
    await userEvent.keyboard('{Escape}');

    expect(useZoomStore.getState().zoomed).toBe(false);
  });

  it('sits outside the controls, so it is there whatever else is', () => {
    run();
    show();

    expect(screen.getByTestId('zoom')).toBeInTheDocument();
  });

  it('is there when there is nothing to draw, since that is a pane too', () => {
    readings('sensors/temp', '21');
    show();

    expect(screen.getByTestId('zoom')).toBeInTheDocument();
  });
});

describe('opening one reading', () => {
  const run = () => readings('sensors/temp', ...wobble(30, 21.5, 1.5));

  /** jsdom lays nothing out, so the plot has to be told how wide it is to find a reading. */
  const plot = () => {
    const area = screen.getByTestId('plotArea');
    area.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 300, height: 100, right: 300, bottom: 100, x: 0, y: 0 }) as DOMRect;

    return area;
  };

  it('opens the reading that was clicked', async () => {
    run();
    show();

    await userEvent.click(plot());

    expect(screen.getByTestId('detail')).toBeInTheDocument();
  });

  // The line says what the run has been doing and the note says what it adds up to. Neither
  // answers 'what is that one, and when' — which is the question a shape on the line prompts.
  it('says where the reading stands, not just what it is', async () => {
    run();
    show();

    await userEvent.click(plot());
    const detail = within(screen.getByTestId('detail'));

    expect(detail.getByText('at')).toBeInTheDocument();
    expect(detail.getByText(/reading/)).toBeInTheDocument();
    expect(detail.getByText('change')).toBeInTheDocument();
    expect(detail.getByText('against')).toBeInTheDocument();
  });

  it('closes on the same click, on the button, and on Escape', async () => {
    run();
    show();

    await userEvent.click(plot());
    await userEvent.click(screen.getByRole('button', { name: 'Close this reading' }));
    expect(screen.queryByTestId('detail')).not.toBeInTheDocument();

    await userEvent.click(plot());
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId('detail')).not.toBeInTheDocument();
  });

  // A detail only a mouse can reach is the readout's oldest failing.
  it('opens from the keyboard on the reading the arrows are on', async () => {
    run();
    show();

    screen.getByTestId('plotArea').focus();
    await userEvent.keyboard('{Home}{ArrowRight}{Enter}');

    expect(within(screen.getByTestId('detail')).getByText('2 of 30')).toBeInTheDocument();
  });

  // Both marks are already drawn on the plot; the card is where they are put into words.
  it('names the marks a reading is wearing', async () => {
    // A run with a spread to measure a fence against, and one reading well past it.
    readings('sensors/temp', '10', '11', '12', '11', '10', '12', '11', '90');
    show();

    screen.getByTestId('plotArea').focus();
    await userEvent.keyboard('{End}{Enter}');

    expect(screen.getByTestId('detail-flags')).toHaveTextContent('outside the fences');
  });

  // A switch has no mean worth standing a reading against; which side of the threshold it is on
  // is the reading.
  it('tells a switch which side of the threshold it is on', async () => {
    readings('sensors/door', ...repeat(6, '0', '0', '0', '1', '1'));
    show();

    screen.getByTestId('plotArea').focus();
    await userEvent.keyboard('{End}{Enter}');

    expect(within(screen.getByTestId('detail')).getByText('level')).toBeInTheDocument();
  });
});

describe('how the readings are laid out', () => {
  // The note is a grid of equal tracks so the readings line up down it as well as across it,
  // and the track is sized to the widest reading the note can print — so nothing spans, nothing
  // wraps, and a value changing length takes up its own slack rather than moving a neighbour.
  it('lays the readings out in one grid rather than a row that wraps', () => {
    readings('sensors/temp', ...wobble(40, 21.5, 1.5));
    show();

    expect(screen.getByTestId('note').querySelectorAll('[data-slot]').length).toBeGreaterThan(10);
    expect(screen.getByTestId('note').querySelector('[data-span]')).toBeNull();
  });

  // An alarm the reader has to scroll to find is not an alarm, and the two that interrupt are
  // the last two readings in the array.
  it('marks a firing alarm so it can be hoisted out of the tail', () => {
    readings('sensors/mixed', '1', 'warming', 'warming', 'warming', 'warming', '2');
    show();

    const skipped = screen.getByTestId('note').querySelector('[data-slot="skipped"]');
    expect(skipped).toHaveAttribute('data-tone', 'alarm');
    expect(skipped).not.toHaveAttribute('data-empty');
  });

  it('leaves an alarm with nothing to say in its place', () => {
    readings('sensors/temp', ...wobble(40, 21.5, 1.5));
    show();

    const silence = screen.getByTestId('note').querySelector('[data-slot="silence"]');
    expect(silence).toHaveAttribute('data-tone', 'alarm');
    expect(silence).toHaveAttribute('data-empty');
  });
});

describe('marking the readings themselves', () => {
  // jsdom lays nothing out, so the plot has to be told how wide it is before it will decide the
  // dots can be told apart.
  const widen = (px: number, tall = 160) => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        ran: ResizeObserverCallback;

        constructor(ran: ResizeObserverCallback) {
          this.ran = ran;
        }

        observe() {
          this.ran(
            [{ contentRect: { width: px, height: tall } } as ResizeObserverEntry],
            this as never,
          );
        }

        unobserve() {}
        disconnect() {}
      },
    );
  };

  /** The dots are circles in a layer of their own, so their size is a radius. */
  const radius = () => Number(screen.getByTestId('dots').querySelector('circle')!.getAttribute('r'));

  // A line alone cannot tell a run sampled ten times from one sampled a thousand, and between
  // two readings it is an interpolation nobody measured.
  it('marks every reading with a dot of its own', () => {
    widen(600);
    readings('sensors/temp', ...wobble(20, 21.5, 1.5));
    show();

    expect(screen.getByTestId('dots').querySelectorAll('circle')).toHaveLength(20);
  });

  // The plot's own SVG is stretched to the pane, and nothing round survives a non-uniform
  // transform in every engine — WebKit, which the desktop build renders in, drew ellipses. This
  // layer has no viewBox, so its user space is CSS pixels; and the positions are percentages, so
  // a stale measurement cannot put a dot off its reading.
  it('draws them in a layer of plain pixels, placed by proportion', () => {
    widen(600, 160);
    readings('sensors/temp', ...wobble(20, 21.5, 1.5));
    show();

    const layer = screen.getByTestId('dots');
    expect(layer).not.toHaveAttribute('viewBox');
    expect(layer.querySelector('circle')).toHaveAttribute('cx', '0%');
  });

  // A mark that is right in a region forty pixels tall is a speck in a chart thrown open over
  // the window, and a mark that is right there is a blot in the region.
  it('draws a bigger dot in a taller plot', () => {
    widen(600, 500);
    readings('sensors/temp', ...wobble(20, 21.5, 1.5));
    show();
    const big = radius();

    cleanup();
    useLogStore.getState().clear();
    widen(600, 60);
    readings('sensors/temp', ...wobble(20, 21.5, 1.5));
    show();
    const small = radius();

    expect(big).toBeGreaterThan(small);
  });

  // The floor and the ceiling are two pixels apart: the mark stays the same mark and only
  // settles into the room it has. A wider range was lost in a region and loud once opened.
  it('will not let a dot outgrow the plot it is in', () => {
    widen(600, 4000);
    readings('sensors/temp', ...wobble(20, 21.5, 1.5));
    show();

    expect(radius() * 2).toBeLessThanOrEqual(5);
  });

  // Five hundred readings across two hundred pixels is not five hundred marks, it is a thicker
  // line lying about its own resolution.
  it('drops them once they are closer together than they are wide', () => {
    widen(120);
    readings('sensors/temp', ...wobble(200, 21.5, 1.5));
    show();

    expect(screen.queryByTestId('dots')).not.toBeInTheDocument();
    expect(screen.getByTestId('plot')).toBeInTheDocument();
  });

  // With every arrival marked, an outlier has to stop being 'a mark' and start being a different
  // one: a ring where the others are filled, and in the fault colour rather than the run's.
  it('keeps the outliers a different mark from the readings around them', () => {
    widen(600);
    readings('sensors/temp', '10', '11', '12', '11', '10', '12', '11', '90');
    show();

    expect(screen.getByTestId('dots')).toBeInTheDocument();
    expect(screen.getAllByTestId('outlier')).toHaveLength(1);
  });
});

describe('how the note is laid out', () => {
  // Every number starts at the same place down the note rather than at the end of whatever word
  // happened to precede it, so the eye reads a column of values instead of hunting each one.
  it('ranges the names right and the numbers left off one shared edge', () => {
    readings('sensors/temp', ...wobble(40, 21.5, 1.5));
    show();

    const cell = screen.getByTestId('note').querySelector('[data-slot="mean"]')!;
    expect(cell.children).toHaveLength(2);
    expect(cell.firstElementChild).toHaveTextContent('mean');
  });

  // Readings of the same kind belong beside each other: a reader looking for the spread should
  // not have to pass the arrival rate to reach it.
  it('opens a row for each group of readings', () => {
    readings('sensors/temp', ...wobble(40, 21.5, 1.5));
    show();

    const note = screen.getByTestId('note');
    const opens = [...note.querySelectorAll('[data-opens]')].map((c) => c.getAttribute('data-slot'));

    // What the run adds up to, then what can be said about it, then what is true of any run.
    expect(opens).toEqual(['shape', 'every']);
  });

  // A switch has no trend and no distribution, so that group is absent rather than a row of
  // dashes — and the group after it still opens a row of its own.
  it('leaves out a group the run has nothing to put in', () => {
    readings('sensors/door', ...repeat(6, '0', '0', '0', '1', '1'));
    show();

    const note = screen.getByTestId('note');
    expect(note.querySelector('[data-slot="shape"]')).toBeNull();
    expect([...note.querySelectorAll('[data-opens]')].map((c) => c.getAttribute('data-slot'))).toEqual([
      'every',
    ]);
  });
});

describe('the ground the plot is drawn on', () => {
  const run = () => readings('sensors/temp', ...wobble(30, 21.5, 1.5));

  // Without an edge, a line lying along the top of the plot cannot be told from a line near the
  // top — which is exactly what the pinned-reading marks depend on being legible.
  it('draws the plot its own edge', () => {
    run();
    show();

    expect(screen.getByTestId('plot-frame')).toBeInTheDocument();
    expect(screen.queryByTestId('gridline')).not.toBeInTheDocument();
  });

});

describe('choosing which readings the note makes', () => {
  const run = () => readings('sensors/temp', ...wobble(30, 21.5, 1.5));

  it('puts away a reading the reader has switched off', () => {
    run();
    show();
    expect(screen.getByTestId('reading-mean')).toBeInTheDocument();

    act(() => useAppearanceStore.getState().toggleReading('mean', false));

    expect(screen.queryByTestId('reading-mean')).not.toBeInTheDocument();
    expect(screen.getByTestId('reading-median')).toBeInTheDocument();
  });

  // A note with nothing left in it is not a note, and an empty rule under the plot is furniture.
  it('drops the note entirely once nothing is left in it', () => {
    run();
    show();

    act(() => READING_IDS.forEach((id) => useAppearanceStore.getState().toggleReading(id, false)));

    expect(screen.queryByTestId('note')).not.toBeInTheDocument();
    expect(screen.getByTestId('plotArea')).toBeInTheDocument();
  });

  // The note's labels are three or four characters long. Hovering one gives the same sentence the
  // Chart panel prints, so the two cannot drift apart.
  it("carries the panel's own words on the cell", () => {
    run();
    show();

    expect(screen.getByTestId('note').querySelector('[data-slot="spread"]')).toHaveAttribute(
      'title',
      expect.stringContaining(READINGS.spread.what),
    );
  });
});

describe('a run whose readings are not measurements', () => {
  const door = ['0', '0', '0', '1', '1', '0', '0', '0', '0', '1', '0', '0', '0', '0', '0', '1', '1', '1', '0', '0'];

  it('counts a switch rather than averaging it', () => {
    readings('sensors/door', ...door);
    show();

    expect(reading('events')).toBe('3');
    expect(reading('duty')).toBe('30%');
  });

  // The average of a door is a number the door has never been.
  it('does not print a mean over two levels', () => {
    readings('sensors/door', ...door);
    show();

    expect(screen.queryByTestId('reading-mean')).not.toBeInTheDocument();
    expect(screen.getByTestId('note')).toHaveAttribute('data-shape', 'state');
  });

  it('draws the line the events were counted against', () => {
    readings('sensors/door', ...door);
    show();

    expect(screen.getByTestId('threshold')).toBeInTheDocument();
  });

  // A pulse clipped to its typical range is a flat line with the events shaved off the top, so
  // the setting is overruled however it is set.
  it('keeps a pulse train on its extremes whatever the setting says', () => {
    useAppearanceStore.getState().setScale('typical');
    readings(
      'sensors/flow',
      ...repeat(10, '1', '2', '3'), '4000',
      ...repeat(4, '1', '2', '3'), '4000',
      ...repeat(4, '1', '2', '3'), '4000',
    );
    show();

    expect(screen.getByTestId('note')).toHaveAttribute('data-shape', 'pulse');
    expect(screen.queryByTestId('pinned')).not.toBeInTheDocument();
  });
});

describe('a selection covering several topics', () => {
  const branch = () => {
    readings('sensors/temp', '21', '22', '23');
    readings('sensors/hum', '54', '55', '56');
  };

  it('draws one plot per topic instead of refusing the selection', () => {
    branch();
    show();

    expect(screen.getAllByTestId('plotArea')).toHaveLength(2);
  });

  // A small multiple has no room for a note, the fields or a readout under the pointer, so the
  // row is the way into a topic that has all of them.
  it('narrows to one topic when a row is clicked, and back out again', async () => {
    branch();
    show();

    await userEvent.click(screen.getByRole('button', { name: /sensors\/hum/ }));

    expect(screen.getByTestId('note')).toBeInTheDocument();
    expect(screen.getAllByTestId('plotArea')).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: /Back to every topic/ }));

    expect(screen.getAllByTestId('plotArea')).toHaveLength(2);
  });
});

describe('when there is nothing to draw', () => {
  it('says a run one message long is one message long', () => {
    readings('sensors/temp', '21');
    show();

    expect(screen.getByTestId('unchartable')).toHaveAttribute('data-reason', 'too-few');
  });

  it('shows the payload behind the claim that a topic is not sending numbers', () => {
    readings('sensors/state', '{"state":"ON"}', '{"state":"OFF"}');
    show();

    expect(screen.getByTestId('void-sample')).toHaveTextContent('"state":"OFF"');
  });

  // Picking a field the topic does not carry is the reader's own doing, and the way out of it is
  // another chip — put beside the sentence rather than left to be hunted for.
  it('offers the fields the run does carry when the chosen one found nothing', async () => {
    readings('sensors/env', '{"temp":21,"hum":54}', '{"temp":22,"hum":55}');
    show();

    await userEvent.click(screen.getByRole('button', { name: 'Chart hum' }));
    expect(screen.getByTestId('plotArea')).toBeInTheDocument();
  });
});

describe('a topic that mostly sends something else', () => {
  // It used to refuse this run outright, and the reader got a sentence naming no topic.
  it('draws what it can, and marks how much it stepped over', () => {
    readings('sensors/mixed', '1', 'warming', 'warming', 'warming', 'warming', '2');
    show();

    expect(screen.getByTestId('plotArea')).toBeInTheDocument();
    expect(within(screen.getByTestId('note')).getByTestId('reading-skipped')).toHaveTextContent('4');
    expect(screen.getByTestId('note').querySelector('[data-slot="skipped"]')).toHaveAttribute(
      'data-tone',
      'alarm',
    );
  });
});
