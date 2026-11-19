import type { Reading } from '../../lib/series';

/**
 * The two runs the preview draws: one of each kind of chart the readings divide into.
 *
 * Made rather than recorded, and made the same way every time. The preview exists so a switch can
 * be seen to do something, and a run that changed between two renders would move the numbers
 * under a reader who had only moved a switch.
 */
export type SampleId = 'measurement' | 'switch';

export const SAMPLES: Record<SampleId, { label: string }> = {
  measurement: { label: 'Measurement' },
  switch: { label: 'Switch' },
};

export const SAMPLE_IDS = Object.keys(SAMPLES) as SampleId[];

const LENGTH = 120;
/** One reading a second, so the note's `every` has a rhythm to report. */
const EVERY_MS = 1000;
/** Any fixed moment: only the gaps between readings are ever read. */
const START = Date.UTC(2026, 0, 1);

/** A repeatable number in 0–1 for a position in the run. Not random — the same run every time. */
function grain(at: number, strand: number): number {
  const wave = Math.sin((at + 1) * 12.9898 * strand + strand * 78.233) * 43758.5453;

  return wave - Math.floor(wave);
}

/**
 * A quantity holding steady near 21.4, with two readings that do not belong to it.
 *
 * Three strands summed, so the scatter is bell-shaped rather than flat and the note has a
 * distribution to name. The two strays are what the ranges differ over: `ends` makes room for
 * them, `mid` pins them to the edge and counts them.
 */
function measurement(at: number): number {
  const scatter = grain(at, 1) + grain(at, 2) + grain(at, 3) - 1.5;
  const stray = at === 37 ? 2.9 : at === 88 ? -2.4 : 0;

  return 21.4 + scatter * 0.42 + stray;
}

/** A switch at rest on 0 that goes to 1 for six readings in every twenty-four. */
const switched = (at: number): number => (at % 24 >= 8 && at % 24 < 14 ? 1 : 0);

const run = (valueAt: (at: number) => number): Reading[] =>
  Array.from({ length: LENGTH }, (_, at) => ({
    value: valueAt(at),
    at: new Date(START + at * EVERY_MS),
  }));

const RUNS: Record<SampleId, Reading[]> = {
  measurement: run(measurement),
  switch: run(switched),
};

export const sampleRun = (id: SampleId): Reading[] => RUNS[id];
