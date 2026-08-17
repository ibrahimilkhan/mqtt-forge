/**
 * Whether a run of readings has a shape with a name.
 *
 * A console can say what the readings were; saying what they are *like* is the step that turns a
 * wall of numbers into something a reader can reason about. A sensor whose readings are normal
 * around a mean is a sensor at rest with noise on it; one that is uniform is usually a counter or
 * a sweep; one that is exponential is usually a wait between events. Each of those is a different
 * thing to go and look at.
 *
 * The test is Kolmogorov–Smirnov: the largest gap between where the readings actually fall and
 * where the candidate says they should. Parameters are estimated from the readings themselves,
 * which makes the standard critical values too generous, so the corrected ones are used below.
 * They are the published approximations at the five per cent level rather than exact tables —
 * enough to keep a wrong name off the chart, not enough to publish a paper with.
 */

/** Below this any shape fits anything, and a verdict is a guess wearing the clothes of a measure. */
export const MIN_SAMPLE = 12;

export type Fit = {
  name: 'normal' | 'uniform' | 'exponential';
  params: { mean?: number; sd?: number; low?: number; high?: number };
  /** The largest gap found, and the largest one this many readings are allowed. */
  d: number;
  critical: number;
};

export function fitDistribution(values: number[]): Fit | null {
  if (values.length < MIN_SAMPLE) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const root = Math.sqrt(n);

  const mean = sorted.reduce((total, value) => total + value, 0) / n;
  const sd = Math.sqrt(sorted.reduce((total, value) => total + (value - mean) ** 2, 0) / n);
  const low = sorted[0];
  const high = sorted[n - 1];

  // Nothing to describe, and every candidate below divides by this.
  if (sd === 0 || high === low) return null;

  const candidates: Fit[] = [
    {
      name: 'normal',
      params: { mean, sd },
      d: largestGap(sorted, (value) => normalCdf((value - mean) / sd)),
      // Lilliefors, for a normal whose mean and deviation came from the sample itself.
      critical: 0.895 / (root - 0.01 + 0.85 / root),
    },
    {
      name: 'uniform',
      params: { low, high },
      d: largestGap(sorted, (value) => (value - low) / (high - low)),
      // Tighter than the 1.36/√n of the tables: the ends were estimated from the sample too.
      critical: 1.09 / root,
    },
  ];

  // A wait cannot be negative, and a run that goes below zero is not one however well it fits.
  if (low >= 0 && mean > 0) {
    candidates.push({
      name: 'exponential',
      params: { mean },
      d: largestGap(sorted, (value) => 1 - Math.exp(-value / mean)),
      critical: 1.06 / root,
    });
  }

  // The best fit is the one furthest inside its own limit, not the one with the smallest gap:
  // the limits differ, so the gaps are not comparable on their own.
  const passing = candidates.filter((candidate) => candidate.d < candidate.critical);

  return passing.sort((a, b) => b.critical - b.d - (a.critical - a.d))[0] ?? null;
}

/**
 * The Kolmogorov–Smirnov statistic: the largest distance between the readings' own step and the
 * candidate's curve, measured on both sides of every step.
 */
function largestGap(sorted: number[], cdf: (value: number) => number): number {
  let largest = 0;

  sorted.forEach((value, index) => {
    const expected = Math.min(Math.max(cdf(value), 0), 1);
    largest = Math.max(largest, (index + 1) / sorted.length - expected, expected - index / sorted.length);
  });

  return largest;
}

/**
 * The standard normal's curve, by Zelen & Severo's approximation — accurate to about 7.5e-8,
 * which is far inside anything the test above can tell apart.
 */
function normalCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;

  const t = 1 / (1 + 0.3275911 * x);
  const error =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);

  return 0.5 * (1 + sign * error);
}
