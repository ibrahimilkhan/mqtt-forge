import { describe, expect, it } from 'vitest';
import { domainFor } from '../../lib/scale';
import { shapeOf } from '../../lib/shape';
import { summarise } from '../../lib/stats';
import { sampleRun } from './sample';

const read = (id: Parameters<typeof sampleRun>[0]) => {
  const readings = sampleRun(id);
  const values = readings.map((reading) => reading.value);
  const summary = summarise(values)!;

  return { readings, values, summary, shape: shapeOf(readings, summary) };
};

// The preview shows one chart of each kind so every group of readings has somewhere to appear.
// If the chart's own rules stopped reading a sample as the kind it stands for, a whole group of
// switches would have nothing to show for themselves.
describe('the sample runs the preview draws', () => {
  it('reads the measurement as a quantity', () => {
    expect(read('measurement').shape.id).toBe('continuous');
  });

  it('reads the switch as something counted rather than averaged', () => {
    expect(read('switch').shape.id).not.toBe('continuous');
  });

  // The ranges are only worth choosing between when they draw the run differently.
  it('has strays for the ranges to disagree about', () => {
    const { values, summary } = read('measurement');
    const typical = domainFor(values, summary, 'typical');

    expect(summary.outliers.length).toBeGreaterThan(0);
    expect(typical.over + typical.under).toBeGreaterThan(0);
    expect(domainFor(values, summary, 'extremes').over).toBe(0);
  });

  it('is the same run every time it is asked for', () => {
    expect(sampleRun('measurement')).toBe(sampleRun('measurement'));
  });
});
