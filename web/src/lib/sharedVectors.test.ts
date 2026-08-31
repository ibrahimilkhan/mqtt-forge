import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fitDistribution } from './distribution';
import type { Reading } from './series';
import { shapeOf } from './shape';
import { summarise } from './stats';

/**
 * The vectors both sides of the console are measured against.
 *
 * The engine's statistics and this folder's are the same arithmetic written twice, and nothing
 * else in the build makes them stay that way. tests/fixtures/statistics holds ten runs and every
 * number both sides should produce from them; the C# reader is
 * tests/MqttForge.UnitTests/Application/Alerts/SharedVectorsTests.cs. A change on either side
 * that moves an answer turns a test red on the side that moved.
 *
 * Read with node:fs and not imported: tsconfig.app.json has no resolveJsonModule, and
 * `npm run build` runs `tsc -b` before vite, so an import of a .json file would go green here
 * and red in CI. Which is why this file is excluded from tsconfig.app.json — and why it has a
 * project of its own, tsconfig.vectors.json, rather than joining typeScale.test.ts in
 * tsconfig.node.json: that project is nodenext, and under nodenext the imports just above need
 * a .js suffix src/lib does not use anywhere.
 */

// Not `new URL('..', import.meta.url)`: Vite statically rewrites that literal pattern to an
// asset URL, which resolves against localhost under Vitest, not the filesystem.
const WEB = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const VECTORS = join(WEB, '..', 'tests', 'fixtures', 'statistics');

/**
 * How far apart the two runtimes are allowed to be.
 *
 * The same 1e-9 the C# reader uses, and for the same reason: everything here is arithmetic IEEE
 * 754 requires to be correctly rounded, except the exponentials inside the two CDFs, where each
 * runtime is free to be an ulp or two out. Counts, indices and names are compared exactly.
 */
const TOLERANCE = 1e-9;

type VectorPulses = {
  rest: number;
  peak: number;
  threshold: number;
  count: number;
  duty: number;
  every: number | null;
  width: number | null;
};

type Vector = {
  name: string;
  readings: { value: number; atMs: number }[];
  expected: {
    summary: {
      n: number;
      low: number;
      high: number;
      mean: number;
      median: number;
      sd: number;
      q1: number;
      q3: number;
      fences: { low: number; high: number };
      outliers: number[];
      slope: number;
    };
    fit: { name: string; mean: number | null; sd: number | null; low: number | null; high: number | null; d: number; critical: number } | null;
    shape: { id: string; levels: number; pulses: VectorPulses | null };
    pulses: VectorPulses;
  };
};

function load(): Vector[] {
  return readdirSync(VECTORS)
    .filter((entry) => entry.endsWith('.json'))
    .sort()
    .map((entry) => JSON.parse(readFileSync(join(VECTORS, entry), 'utf8')) as Vector);
}

const vectors = load();

const readingsOf = (vector: Vector): Reading[] =>
  vector.readings.map((reading) => ({ value: reading.value, at: new Date(reading.atMs) }));

const valuesOf = (vector: Vector): number[] => vector.readings.map((reading) => reading.value);

/**
 * The failure sentence, built the same way the C# reader builds it.
 *
 * What a broken vector looks like: change flat-line.json's summary.sd from 0 to 0.5 and this
 * goes red with `flat-line.summary.sd: the vector says 0.5, this side answers 0`, and so does
 * SharedVectorsTests. Two reds from one edit is how you tell the fixture is wrong rather than
 * the code — one red, on one side only, is the two sides having genuinely drifted apart.
 */
function close(name: string, field: string, expected: number, actual: number): void {
  expect(
    Math.abs(expected - actual),
    `${name}.${field}: the vector says ${expected}, this side answers ${actual}`,
  ).toBeLessThanOrEqual(TOLERANCE);
}

function nullable(name: string, field: string, expected: number | null, actual: number | null): void {
  if (expected === null) {
    expect(actual, `${name}.${field}: the vector says null, this side answers ${actual}`).toBeNull();
    return;
  }

  expect(actual, `${name}.${field}: the vector says ${expected}, this side answers null`).not.toBeNull();
  close(name, field, expected, actual!);
}

function pulsesMatch(name: string, field: string, expected: VectorPulses, actual: VectorPulses): void {
  close(name, `${field}.rest`, expected.rest, actual.rest);
  close(name, `${field}.peak`, expected.peak, actual.peak);
  close(name, `${field}.threshold`, expected.threshold, actual.threshold);
  expect(actual.count, `${name}.${field}.count`).toBe(expected.count);
  close(name, `${field}.duty`, expected.duty, actual.duty);
  nullable(name, `${field}.every`, expected.every, actual.every);
  nullable(name, `${field}.width`, expected.width, actual.width);
}

describe('the shared statistics vectors', () => {
  it('finds every vector it is meant to check', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(8);
  });
});

describe.each(vectors)('$name', (vector) => {
  const values = valuesOf(vector);
  const { name } = vector;

  it('summarises it the way the vector says', () => {
    const summary = summarise(values)!;
    const expected = vector.expected.summary;

    expect(summary.n).toBe(expected.n);
    close(name, 'summary.low', expected.low, summary.low);
    close(name, 'summary.high', expected.high, summary.high);
    close(name, 'summary.mean', expected.mean, summary.mean);
    close(name, 'summary.median', expected.median, summary.median);
    close(name, 'summary.sd', expected.sd, summary.sd);
    close(name, 'summary.q1', expected.q1, summary.q1);
    close(name, 'summary.q3', expected.q3, summary.q3);
    close(name, 'summary.fences.low', expected.fences.low, summary.fences.low);
    close(name, 'summary.fences.high', expected.fences.high, summary.fences.high);
    close(name, 'summary.slope', expected.slope, summary.slope);
    expect(summary.outliers, `${name}.summary.outliers`).toEqual(expected.outliers);
  });

  it('fits it the way the vector says', () => {
    const fit = fitDistribution(values);
    const expected = vector.expected.fit;

    if (expected === null) {
      expect(fit, `${name}.fit: the vector says nothing fits`).toBeNull();
      return;
    }

    expect(fit, `${name}.fit: the vector says ${expected.name}`).not.toBeNull();
    expect(fit!.name).toBe(expected.name);
    nullable(name, 'fit.mean', expected.mean, fit!.params.mean ?? null);
    nullable(name, 'fit.sd', expected.sd, fit!.params.sd ?? null);
    nullable(name, 'fit.low', expected.low, fit!.params.low ?? null);
    nullable(name, 'fit.high', expected.high, fit!.params.high ?? null);
    close(name, 'fit.d', expected.d, fit!.d);
    close(name, 'fit.critical', expected.critical, fit!.critical);
  });

  it('shapes it the way the vector says', () => {
    const shape = shapeOf(readingsOf(vector), summarise(values)!);
    const expected = vector.expected.shape;

    // The one place a vector is translated, and the only one allowed. The vectors record the
    // engine's answer, which has a fourth id this side does not: below ENOUGH_TO_CLASSIFY the
    // engine says 'unknown' where shapeOf says 'continuous', because a chart has to draw
    // something and a rule has to be able to say 'not yet'. Everything else is compared as
    // written; a second translation appearing here would mean the two sides had really drifted.
    const id = expected.id === 'unknown' ? 'continuous' : expected.id;

    expect(shape.id, `${name}.shape.id`).toBe(id);
    expect('levels' in shape ? shape.levels : 0, `${name}.shape.levels`).toBe(expected.levels);

    if (expected.pulses === null) {
      expect('pulses' in shape, `${name}.shape.pulses: the vector says none`).toBe(false);
      return;
    }

    expect('pulses' in shape, `${name}.shape.pulses: the vector has some`).toBe(true);
    pulsesMatch(name, 'shape.pulses', expected.pulses, (shape as { pulses: VectorPulses }).pulses);
  });
});
