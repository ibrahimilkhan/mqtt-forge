import { describe, expect, it } from 'vitest';
import { cadence, changePoint, summarise } from './stats';

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

describe('changePoint', () => {
  // A step is the most actionable thing a sensor can say, and it is the one thing neither the
  // mean nor the trend reports: both of them describe the run as though it were all one thing.
  it('finds where a run moved from one level to another', () => {
    const stepped = [...Array(20).fill(21), ...Array(20).fill(26)];

    expect(changePoint(stepped)).toMatchObject({ at: 20, before: 21, after: 26 });
  });

  it('reports how far it stepped, and which way', () => {
    expect(changePoint([...Array(20).fill(26), ...Array(20).fill(21)])?.shift).toBe(-5);
  });

  it('finds the step through noise on either side of it', () => {
    const wobble = (base: number, i: number) => base + (i % 2 === 0 ? 0.1 : -0.1);
    const stepped = [
      ...Array.from({ length: 20 }, (_, i) => wobble(21, i)),
      ...Array.from({ length: 20 }, (_, i) => wobble(26, i)),
    ];

    expect(changePoint(stepped)?.at).toBe(20);
  });

  // Noise always has a best split; what it does not have is a step. Reporting the best split of
  // a run that never moved would put an event on every sensor in the building.
  it('finds nothing in a run that only wobbles', () => {
    const wobble = Array.from({ length: 40 }, (_, i) => 21 + Math.sin(i * 2.3) * 0.5);

    expect(changePoint(wobble)).toBeNull();
  });

  // A climb has a best split too — the middle of the slope — and calling that a step would be
  // describing a ramp as a stair.
  it('finds nothing in a run that simply climbs', () => {
    expect(changePoint(Array.from({ length: 40 }, (_, i) => 20 + i))).toBeNull();
  });

  // The rise is real, but it happens at one moment rather than over the run: two levels explain
  // the readings and a slope through them does not.
  it('still finds a step in a run that climbs a little on both sides of it', () => {
    const stepped = Array.from({ length: 40 }, (_, i) => (i < 20 ? 21 : 26) + i * 0.01);

    expect(changePoint(stepped)?.at).toBe(20);
  });

  it('finds nothing in a run too short to have two sides', () => {
    expect(changePoint([21, 21, 26, 26])).toBeNull();
  });

  it('finds nothing in a run that never moved', () => {
    expect(changePoint(Array(40).fill(21))).toBeNull();
  });

  // The ends are not a step: one reading against thirty-nine is an outlier, and there is a fence
  // for those.
  it('keeps its distance from the ends of the run', () => {
    const spike = [...Array(39).fill(21), 90];

    expect(changePoint(spike)).toBeNull();
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
