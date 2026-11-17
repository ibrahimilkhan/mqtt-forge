import { describe, expect, it } from 'vitest';
import { snapTo } from './snap';

describe('snapTo', () => {
  it('rounds to the nearest step and leaves a value alone with no step', () => {
    expect(snapTo(0.0123, 0.01)).toBeCloseTo(0.01);
    expect(snapTo(0.0151, 0.01)).toBeCloseTo(0.02);
    expect(snapTo(0.0123, 0)).toBe(0.0123);
  });
});
