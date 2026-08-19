import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
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

  // The plainest detail level draws no controls at all, and a bare line is the drawing that most
  // often wants more room — so this control is not one of them.
  it('is there at every detail level', () => {
    useAppearanceStore.getState().setChart('plain');
    run();
    show();

    expect(screen.getByTestId('zoom')).toBeInTheDocument();
    expect(screen.queryByTestId('note')).not.toBeInTheDocument();
  });

  it('is there when there is nothing to draw, since that is a pane too', () => {
    readings('sensors/temp', '21');
    show();

    expect(screen.getByTestId('zoom')).toBeInTheDocument();
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

  it('marks the quarters when asked', () => {
    useAppearanceStore.getState().setGrid('lines');
    run();
    show();

    expect(screen.getAllByTestId('gridline').length).toBeGreaterThan(0);
  });

  it('draws neither when the reader wants the line alone', () => {
    useAppearanceStore.getState().setGrid('none');
    run();
    show();

    expect(screen.queryByTestId('plot-frame')).not.toBeInTheDocument();
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

  it('reads a running total as the rate it is climbing at', () => {
    const bursts = [0, 5, 9, 2, 12, 0, 8, 3, 15, 6, 1, 9, 4, 11, 7, 2, 10, 5, 8];
    const totals = bursts.reduce<number[]>((run, burst) => [...run, run[run.length - 1] + burst], [1000]);
    readings('sensors/packets', ...totals.map(String));
    show();

    expect(screen.getByTestId('note')).toHaveAttribute('data-shape', 'counter');
    // How much it counted across the run, rather than the value it happens to sit at — which
    // only says when the device last restarted. The rate needs arrivals spread over real time,
    // and the log stamps a burst of pushes with one instant.
    expect(reading('counted')).toBe(`${totals[totals.length - 1] - totals[0]}`);
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
