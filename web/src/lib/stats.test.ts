import { describe, expect, it } from 'vitest';
import { cadence, summarise } from './stats';

const at = (...seconds: number[]) => seconds.map((second) => new Date(2026, 0, 1, 12, 0, second));

describe('summarise', () => {
  it('counts the readings and finds the ends of them', () => {
    expect(summarise([3, 1, 4, 1, 5])).toMatchObject({ n: 5, low: 1, high: 5 });
  });

  it('averages them', () => {
    expect(summarise([2, 4, 6, 8])!.mean).toBe(5);
  });

  // The middle of an even count is between two readings, and half of the pair is not the middle.
  it('takes the middle of an even count as the midpoint of the pair', () => {
    expect(summarise([1, 2, 3, 4])!.median).toBe(2.5);
  });

  it('takes the middle of an odd count as the reading in the middle', () => {
    expect(summarise([5, 1, 3])!.median).toBe(3);
  });

  // The population deviation, not the sample's: these are all the readings the log holds, not a
  // draw from a larger set of them.
  it('measures the spread as the population deviation', () => {
    expect(summarise([2, 4, 4, 4, 5, 5, 7, 9])!.sd).toBe(2);
  });

  it('leaves the spread at zero when nothing moved', () => {
    expect(summarise([7, 7, 7])!.sd).toBe(0);
  });

  // Quartiles by linear interpolation between the readings the quarter falls between — the
  // definition numpy, R and spreadsheets reach for by default, so a reader checking the note
  // against their own tooling gets the same numbers back.
  it('quarters the readings', () => {
    expect(summarise([1, 2, 3, 4, 5, 6, 7, 8])).toMatchObject({ q1: 2.75, q3: 6.25 });
  });

  // Tukey's fences: a reading beyond one and a half box-widths of the box is the usual line
  // between spread and something that does not belong to it.
  it('marks the readings outside the fences', () => {
    const { outliers } = summarise([10, 11, 12, 11, 10, 12, 11, 90])!;

    expect(outliers).toEqual([7]);
  });

  it('marks nothing when every reading sits inside the fences', () => {
    expect(summarise([10, 11, 12, 11, 10, 12])!.outliers).toEqual([]);
  });

  // A run that never moves has no box to measure a fence against, so nothing is far from it.
  it('marks nothing in a run that never moved', () => {
    expect(summarise([7, 7, 7, 7])!.outliers).toEqual([]);
  });

  it('says which way the readings are going', () => {
    expect(summarise([1, 2, 3, 4, 5])!.slope).toBeCloseTo(1);
    expect(summarise([5, 4, 3, 2, 1])!.slope).toBeCloseTo(-1);
    expect(summarise([3, 3, 3, 3])!.slope).toBe(0);
  });

  it('has nothing to say about an empty run', () => {
    expect(summarise([])).toBeNull();
  });
});

describe('cadence', () => {
  it('reports how often the readings arrive', () => {
    expect(cadence(at(0, 1, 2, 3, 4))?.every).toBe(1000);
  });

  // The median gap, not the mean: one reconnection gap of an hour should not move the answer
  // to 'every twenty minutes' for a sensor that has published every second all day.
  it('takes the middle gap rather than the average of them', () => {
    expect(cadence(at(0, 1, 2, 3, 60))?.every).toBe(1000);
  });

  it('measures how far the gaps stray from it', () => {
    expect(cadence(at(0, 1, 2, 3, 4))?.jitter).toBe(0);
    expect(cadence(at(0, 1, 3, 4, 7))?.jitter).toBeGreaterThan(0);
  });

  it('has nothing to say about a single arrival', () => {
    expect(cadence(at(0))).toBeNull();
  });

  // Batched arrivals share a timestamp, and 'every 0ms' is not a cadence.
  it('has nothing to say when every arrival shares one instant', () => {
    expect(cadence(at(0, 0, 0))).toBeNull();
  });
});
