import { describe, expect, it } from 'vitest';
import { domainFor, pinned, positionIn, SCALES } from './scale';
import { summarise } from './stats';

const domain = (values: number[], mode: 'extremes' | 'typical' | 'log') =>
  domainFor(values, summarise(values)!, mode);

// The run the brief is about: a sensor that says 1, 2, 3 all day and once says 4000.
const spiked = [...Array.from({ length: 30 }, (_, i) => (i % 3) + 1), 4000];

describe('domainFor, on the extremes', () => {
  it('spends the plot on the whole run', () => {
    expect(domain([1, 5, 9], 'extremes')).toMatchObject({ low: 1, high: 9 });
  });

  it('leaves nothing outside it', () => {
    expect(domain(spiked, 'extremes')).toMatchObject({ over: 0, under: 0 });
  });
});

describe('domainFor, on the typical range', () => {
  // The whole point of the option: thirty readings between 1 and 3 get the plot's height, and the
  // one reading at 4000 is pinned to the top rather than flattening them onto the bottom pixel.
  it('scales to where the readings mostly are, not to the spike', () => {
    const band = domain(spiked, 'typical');

    expect(band.high).toBeLessThan(10);
    expect(band.mode).toBe('typical');
  });

  it('counts what it had to pin to an edge rather than hiding it', () => {
    expect(domain(spiked, 'typical').over).toBe(1);
  });

  it('never reaches past the run itself', () => {
    const band = domain([10, 11, 12, 13, 14, 15, 16, 17], 'typical');

    expect(band.low).toBeGreaterThanOrEqual(10);
    expect(band.high).toBeLessThanOrEqual(17);
  });

  // A run of 1, 2, 3 repeating has quartiles a hair apart, so the fences collapse onto the middle
  // and would clip every reading in the run. Deviation about the median has to catch that.
  it('finds a band on a run whose middle half has no width', () => {
    const flatMiddle = [...Array.from({ length: 20 }, () => 2), 1, 3, 900];
    const band = domain(flatMiddle, 'typical');

    expect(band.high).toBeLessThan(900);
    expect(band.low).toBeLessThanOrEqual(1);
  });

  // A flat line with one spike on it has no middle to scale to: whatever band is drawn either
  // holds the spike or holds nothing. The extremes are the honest picture, and the mode says so
  // rather than claiming a typical range it did not find.
  it('falls back to the extremes on a run with no scatter but a spike', () => {
    const flat = [...Array.from({ length: 40 }, () => 5), 999];

    expect(domain(flat, 'typical')).toMatchObject({ mode: 'extremes', high: 999 });
  });

  // One reading in ten is not a stray, and a band that dropped it would be hiding a tenth of the
  // run to make the other nine easier to look at.
  it('keeps a departure that a short run has too many of to call rare', () => {
    const few = [...Array.from({ length: 9 }, () => 5), 999];

    expect(domain(few, 'typical')).toMatchObject({ mode: 'extremes', high: 999 });
  });

  // Under a handful of readings the middle half is two of them, and a robust range is a guess
  // dressed as a measure.
  it('leaves a short run on its extremes', () => {
    expect(domain([1, 2, 400], 'typical')).toMatchObject({ mode: 'extremes', high: 400 });
  });

  it('draws a run that never moved down the middle either way', () => {
    expect(domain([7, 7, 7], 'typical')).toMatchObject({ low: 7, high: 7 });
  });
});

describe('domainFor, on a log axis', () => {
  it('takes a positive run', () => {
    expect(domain([1, 10, 100, 1000], 'log')).toMatchObject({ log: true, mode: 'log' });
  });

  it('gives each decade the same height', () => {
    const band = domain([1, 10, 100], 'log');

    expect(positionIn(band, 10)).toBeCloseTo(0.5);
  });

  // Zero has no place on a log axis and a negative has no answer at all, so the mode steps aside
  // rather than quietly moving readings to somewhere they can be drawn.
  it('steps aside for a run that reaches zero', () => {
    expect(domain([0, 5, 50], 'log')).toMatchObject({ log: false, mode: 'extremes' });
  });

  it('steps aside for a run that goes negative', () => {
    expect(domain([-4, 5, 50], 'log').mode).toBe('extremes');
  });
});

describe('positionIn', () => {
  it('puts the low edge at nothing and the high edge at one', () => {
    const band = domain([0, 10], 'extremes');

    expect(positionIn(band, 0)).toBe(0);
    expect(positionIn(band, 10)).toBe(1);
  });

  it('pins a reading past an edge to the edge rather than drawing it outside the plot', () => {
    const band = domain(spiked, 'typical');

    expect(positionIn(band, 4000)).toBe(1);
  });

  it('says which readings it had to pin', () => {
    const band = domain(spiked, 'typical');

    expect(pinned(band, 4000)).toBe(true);
    expect(pinned(band, 2)).toBe(false);
  });

  it('puts a run that never moved down the middle', () => {
    expect(positionIn(domain([7, 7, 7], 'extremes'), 7)).toBe(0.5);
  });
});

describe('the catalogue', () => {
  it('names every mode for the reader picking one', () => {
    expect(Object.keys(SCALES)).toEqual(['extremes', 'typical', 'log']);
  });
});
