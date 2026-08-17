import { describe, expect, it } from 'vitest';
import { fitDistribution, MIN_SAMPLE } from './distribution';

// A fixed generator, so a claim about a distribution is checked against the same sample every
// run. Seeded rather than random: a flaky statistics test teaches nobody anything.
function draws(seed: number, count: number, shape: (uniform: number, next: () => number) => number) {
  let state = seed;
  const next = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return (state + 0.5) / 4294967296;
  };

  return Array.from({ length: count }, () => shape(next(), next));
}

const uniforms = (seed: number, count: number) => draws(seed, count, (u) => u);
const normals = (seed: number, count: number) =>
  // Box–Muller, so the sample really is normal rather than nearly so.
  draws(seed, count, (u, next) => 20 + 2 * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next()));
const exponentials = (seed: number, count: number) => draws(seed, count, (u) => -Math.log(u) * 5);

describe('fitDistribution', () => {
  it('calls a normal sample normal, and says what its parameters are', () => {
    const fit = fitDistribution(normals(7, 120));

    expect(fit?.name).toBe('normal');
    expect(fit?.params.mean).toBeCloseTo(20, 0);
    expect(fit?.params.sd).toBeCloseTo(2, 0);
  });

  // A ramp is the uniform distribution exactly: every step is equally likely, by construction.
  it('calls an even ramp uniform, and says where it runs from and to', () => {
    const fit = fitDistribution(Array.from({ length: 40 }, (_, i) => i + 1));

    expect(fit?.name).toBe('uniform');
    expect(fit?.params.low).toBe(1);
    expect(fit?.params.high).toBe(40);
  });

  it('calls a uniform sample uniform', () => {
    expect(fitDistribution(uniforms(11, 120))?.name).toBe('uniform');
  });

  // The shape of a wait: gaps between arrivals that have no memory of the last one.
  it('calls an exponential sample exponential, and says what its mean wait is', () => {
    const fit = fitDistribution(exponentials(3, 200));

    expect(fit?.name).toBe('exponential');
    expect(fit?.params.mean).toBeCloseTo(5, 0);
  });

  // Two clusters and nothing in between is not one of these shapes, and saying it is normal
  // because the arithmetic tolerates it would be worse than saying nothing.
  it('names no distribution for a run that sits in two clumps', () => {
    const halves = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 0 : 100));

    expect(fitDistribution(halves)).toBeNull();
  });

  it('names no distribution for a run that never moved', () => {
    expect(fitDistribution(Array.from({ length: 40 }, () => 21.5))).toBeNull();
  });

  // Below this every shape fits everything, and a verdict drawn from four readings is a guess
  // wearing the clothes of a measurement.
  it('says nothing at all about too few readings', () => {
    expect(fitDistribution(normals(7, MIN_SAMPLE - 1))).toBeNull();
  });

  it('keeps the exponential off readings that go negative, which it cannot describe', () => {
    expect(fitDistribution(exponentials(3, 120).map((value) => value - 20))?.name).not.toBe(
      'exponential',
    );
  });
});
