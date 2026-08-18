import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderWithClient as render } from '../../test/renderWithClient';
import { useAppearanceStore } from '../../stores/appearanceStore';
import { useLogStore } from '../../stores/logStore';
import { useSelectionStore } from '../../stores/selectionStore';
import { TrafficPane } from './TrafficPane';
import { useHoldStore } from './useTraffic';

const chip = { label: 'sensors/#', filter: 'sensors/#' };

/** Oldest first, so the newest lands at the head of the store. */
const readings = (topic: string, ...bodies: string[]) =>
  bodies.forEach((body) => useLogStore.getState().push({ kind: 'recv', topic, body }));

const reading = (slot: string) => screen.getByTestId(`reading-${slot}`).textContent;

const repeat = (times: number, ...pattern: string[]) =>
  Array.from({ length: times * pattern.length }, (_, i) => pattern[i % pattern.length]);

beforeEach(() => {
  useLogStore.getState().clear();
  useSelectionStore.getState().clear();
  useHoldStore.getState().release();
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
