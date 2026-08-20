import { describe, expect, it } from 'vitest';
import type { Reading } from './series';
import { shapeOf } from './shape';
import { summarise } from './stats';

/** One reading a second, which is the cadence the timings below are read against. */
const run = (...values: number[]): Reading[] =>
  values.map((value, index) => ({ value, at: new Date(2026, 0, 1, 12, 0, index) }));

const shape = (...values: number[]) => shapeOf(run(...values), summarise(values)!);

const repeat = (times: number, ...pattern: number[]) =>
  Array.from({ length: times * pattern.length }, (_, i) => pattern[i % pattern.length]);

describe('shapeOf', () => {
  it('reads a run of measurements as measurements', () => {
    expect(shape(...[21.5, 21.6, 21.4, 21.7, 21.9, 22.1, 22, 21.8, 21.6, 21.5])).toMatchObject({
      id: 'continuous',
    });
  });

  // Not enough run to have a habit; calling one this early would be reading a coincidence.
  it('says nothing about a run too short to have a shape', () => {
    expect(shape(0, 0, 1, 0)).toMatchObject({ id: 'continuous' });
  });

  it('reads a run that never moved as measurements', () => {
    expect(shape(...Array.from({ length: 20 }, () => 7))).toMatchObject({ id: 'continuous' });
  });
});

describe('shapeOf, on a switch', () => {
  const door = [0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0];

  it('reads two levels as a state rather than a quantity', () => {
    expect(shape(...door)).toMatchObject({ id: 'state', levels: 2 });
  });

  // The number the reader wants off a door sensor is how many times it opened, not what it was
  // on average — which for this run would be 0.3 of a door.
  it('counts the times it left the level it rests at', () => {
    expect(shape(...door)).toMatchObject({ pulses: { count: 3 } });
  });

  it('says what share of the run was spent away from rest', () => {
    expect(shape(...door)).toMatchObject({ pulses: { duty: 0.3 } });
  });

  it('names the two levels it moves between', () => {
    expect(shape(...door)).toMatchObject({ pulses: { rest: 0, peak: 1 } });
  });

  // A sensor that is high nearly all the time and drops twice has two events, not four hundred:
  // the event is whichever side the run spends less of itself on.
  it('reads a run that rests high and drops as drops', () => {
    const link = [1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1];

    expect(shape(...link)).toMatchObject({ id: 'state', pulses: { count: 2, rest: 1, peak: 0 } });
  });

  it('times how long an excursion lasted and how often one came', () => {
    // High for two readings out of every five, at a reading a second.
    expect(shape(...repeat(6, 0, 0, 0, 1, 1))).toMatchObject({
      pulses: { width: 2000, every: 5000 },
    });
  });
});

describe('shapeOf, on a pulse train', () => {
  // The brief's own run: a sensor that reads small all day and occasionally reads enormous.
  const spikes = [...repeat(10, 1, 2, 3), 4000, ...repeat(4, 1, 2, 3), 4000, ...repeat(4, 1, 2, 3), 4000];

  it('reads a rest with events on it as a pulse train', () => {
    expect(shape(...spikes)).toMatchObject({ id: 'pulse' });
  });

  it('counts the events rather than averaging them away', () => {
    expect(shape(...spikes)).toMatchObject({ pulses: { count: 3 } });
  });

  it('names the level it rests at and the level it goes to', () => {
    expect(shape(...spikes)).toMatchObject({ pulses: { rest: 2, peak: 4000 } });
  });

  // One reading past the fences is an outlier — the chart already rings it and the note already
  // counts it. Calling that a rhythm would be inventing a machine behind a single reading.
  it('does not call a lone spike a pulse train', () => {
    expect(shape(...repeat(10, 1, 2, 3), 4000)).toMatchObject({ id: 'continuous' });
  });

  // A run that steps up and stays there has left its old level rather than visited a new one.
  it('does not call a step a pulse train', () => {
    expect(shape(...repeat(6, 1, 2, 3), ...repeat(6, 90, 91, 92))).toMatchObject({
      id: 'continuous',
    });
  });

  // Half a sine is above the middle and half below, so there is no rest to leave.
  it('does not call a swing a pulse train', () => {
    const swing = Array.from({ length: 60 }, (_, i) => Math.round(Math.sin(i / 3) * 100) / 10);

    expect(shapeOf(run(...swing), summarise(swing)!)).toMatchObject({ id: 'continuous' });
  });
});

// A running total used to be a fourth shape here, read as the rate it climbs at. Nobody asked
// for it and it fired rarely; a total is a quantity going up, and the trend already says so.
describe('shapeOf, on a run that only ever climbs', () => {
  it('reads it as a quantity going somewhere', () => {
    const bursts = [0, 5, 9, 2, 12, 0, 8, 3, 15, 6, 1, 9, 4, 11, 7, 2, 10, 5, 8];
    const totals = bursts.reduce<number[]>((run, burst) => [...run, run[run.length - 1] + burst], [1000]);

    expect(shape(...totals)).toMatchObject({ id: 'continuous' });
  });
});
