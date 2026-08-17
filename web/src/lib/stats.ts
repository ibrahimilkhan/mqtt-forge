/**
 * What a run of readings adds up to.
 *
 * The chart shows the shape; this is what can be said about it in numbers — where the middle is,
 * how far the readings stray from it, which of them do not belong to the run at all, and whether
 * the whole thing is going anywhere. A console that only ever shows the latest value leaves the
 * reader to do this arithmetic by eye, which is exactly the arithmetic an eye is worst at.
 */
export type Summary = {
  n: number;
  low: number;
  high: number;
  mean: number;
  median: number;
  /** Population deviation: these are all the readings held, not a sample drawn from more. */
  sd: number;
  q1: number;
  q3: number;
  /** Tukey's fences — the usual line between spread and a reading that does not belong to it. */
  fences: { low: number; high: number };
  /** Indices into the run, in order. */
  outliers: number[];
  /** Least-squares slope in units per reading; zero when the run is flat. */
  slope: number;
};

export function summarise(values: number[]): Summary | null {
  if (values.length === 0) return null;

  const n = values.length;
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((total, value) => total + value, 0) / n;
  const variance = values.reduce((total, value) => total + (value - mean) ** 2, 0) / n;

  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1;
  const fences = { low: q1 - 1.5 * iqr, high: q3 + 1.5 * iqr };

  return {
    n,
    low: sorted[0],
    high: sorted[n - 1],
    mean,
    median: quantile(sorted, 0.5),
    sd: Math.sqrt(variance),
    q1,
    q3,
    fences,
    // A run that never moved has no box to measure a fence against, so nothing is far from it.
    outliers:
      iqr === 0
        ? []
        : values.reduce<number[]>((found, value, index) => {
            if (value < fences.low || value > fences.high) found.push(index);
            return found;
          }, []),
    slope: slopeOf(values),
  };
}

export type Cadence = {
  /** The middle gap between arrivals, in milliseconds. */
  every: number;
  /** How far the gaps stray from it — the median absolute deviation, in milliseconds. */
  jitter: number;
};

/**
 * How regularly the readings arrive.
 *
 * A sensor with a period is a sensor whose silence means something, and the period is the only
 * thing that says how long a silence has to be before it does. The middle gap rather than the
 * average of them: one reconnection should not turn a second-by-second sensor into a slow one.
 */
export function cadence(times: Date[]): Cadence | null {
  if (times.length < 2) return null;

  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i].getTime() - times[i - 1].getTime());

  const every = quantile([...gaps].sort((a, b) => a - b), 0.5);
  // A batch of arrivals shares one instant, and 'every 0ms' is not a cadence.
  if (every <= 0) return null;

  const strays = gaps.map((gap) => Math.abs(gap - every)).sort((a, b) => a - b);

  return { every, jitter: quantile(strays, 0.5) };
}

/** Linear interpolation between the two readings the quantile falls between. */
function quantile(sorted: number[], fraction: number): number {
  const position = (sorted.length - 1) * fraction;
  const below = Math.floor(position);
  const above = Math.ceil(position);

  return below === above
    ? sorted[below]
    : sorted[below] + (sorted[above] - sorted[below]) * (position - below);
}

/** Least squares against the reading's place in the run, which is how the chart spaces them. */
function slopeOf(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;

  const meanIndex = (n - 1) / 2;
  const meanValue = values.reduce((total, value) => total + value, 0) / n;

  let covariance = 0;
  let spread = 0;
  values.forEach((value, index) => {
    covariance += (index - meanIndex) * (value - meanValue);
    spread += (index - meanIndex) ** 2;
  });

  return spread === 0 ? 0 : covariance / spread;
}
