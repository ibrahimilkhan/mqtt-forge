import { describe, expect, it } from 'vitest';
import { chartable, MOST_LINES } from './chartable';
import { runsOf, type LogEntry } from '../stores/logStore';

/**
 * The chart takes the traffic as one run per topic now. These tests still describe it as one
 * sequence — that is how a reader thinks of a selection — and this is the same grouping the log
 * itself does, so every assertion below is about the same traffic it always was.
 */
const asRuns = (entries: LogEntry[]) => runsOf(entries);

let nextId = 0;

/** Newest first, the order the log holds them in. */
const log = (...messages: Array<[topic: string, body: string]>): LogEntry[] =>
  messages
    .map(([topic, body], index) => ({
      id: nextId++,
      kind: 'recv' as const,
      at: new Date(2026, 0, 1, 12, 0, index).getTime(),
      topic,
      body,
    }))
    .reverse();

const run = (topic: string, ...bodies: string[]) =>
  log(...bodies.map((body) => [topic, body] as [string, string]));

describe('chartable, on one topic', () => {
  it('draws the line', () => {
    expect(chartable(asRuns(run('sensors/temp', '21', '22', '23')))).toMatchObject({
      kind: 'one',
      series: { topic: 'sensors/temp' },
    });
  });
});

describe('chartable, on a selection covering several topics', () => {
  // The branch a reader clicks in the tree is a wildcard over its children, and until now that
  // was the commonest way to end up with no chart at all.
  it('draws one line per topic rather than refusing the selection', () => {
    const mixed = log(
      ['sensors/a', '1'], ['sensors/b', '90'],
      ['sensors/a', '2'], ['sensors/b', '91'],
      ['sensors/a', '3'], ['sensors/b', '92'],
    );

    expect(chartable(asRuns(mixed))).toMatchObject({
      kind: 'many',
      series: [{ topic: 'sensors/a' }, { topic: 'sensors/b' }],
    });
  });

  it('leads with the topic the selection is mostly about', () => {
    const lopsided = log(
      ['sensors/quiet', '1'], ['sensors/quiet', '2'],
      ['sensors/busy', '5'], ['sensors/busy', '6'], ['sensors/busy', '7'], ['sensors/busy', '8'],
    );

    expect((chartable(asRuns(lopsided)) as { series: Array<{ topic: string }> }).series[0].topic).toBe(
      'sensors/busy',
    );
  });

  it('draws one line, not a set of one, when only one topic in the branch charts', () => {
    const mixed = log(
      ['sensors/a', '1'], ['sensors/b', 'ON'],
      ['sensors/a', '2'], ['sensors/b', 'OFF'],
      ['sensors/a', '3'], ['sensors/b', 'ON'],
    );

    expect(chartable(asRuns(mixed))).toMatchObject({ kind: 'one', series: { topic: 'sensors/a' } });
  });

  it('caps the lines and says how many it left out', () => {
    const many = log(
      ...Array.from({ length: (MOST_LINES + 3) * 2 }, (_, i) => [
        `sensors/${i % (MOST_LINES + 3)}`,
        `${i}`,
      ] as [string, string]),
    );
    const drawn = chartable(asRuns(many)) as { kind: string; series: unknown[]; more: number };

    expect(drawn.kind).toBe('many');
    expect(drawn.series).toHaveLength(MOST_LINES);
    expect(drawn.more).toBe(3);
  });
});

describe('chartable, when there is nothing to draw', () => {
  // Four situations used to share one sentence, and three of them were temporary.
  it('says the run is one message old rather than that it cannot be charted', () => {
    expect(chartable(asRuns(run('sensors/temp', '21')))).toMatchObject({
      kind: 'none',
      reason: { code: 'too-few', have: 1 },
    });
  });

  it('says nothing has arrived at all', () => {
    expect(chartable(asRuns([]))).toMatchObject({ reason: { code: 'too-few', have: 0 } });
  });

  it('says the bodies are not numbers, and carries the newest one as evidence', () => {
    expect(chartable(asRuns(run('sensors/state', '{"state":"ON"}', '{"state":"OFF"}')))).toMatchObject({
      reason: { code: 'no-numbers', sample: '{"state":"OFF"}' },
    });
  });

  it('counts the topics it looked at, so a branch does not read as one topic', () => {
    const mixed = log(['sensors/a', 'ON'], ['sensors/b', 'OFF'], ['sensors/c', 'ON']);

    expect(chartable(asRuns(mixed))).toMatchObject({ reason: { code: 'no-numbers', topics: 3 } });
  });

  // Picking a field the topic does not carry is the reader's own doing, and the way out of it is
  // another chip rather than another topic.
  it('names the field when it was the field that found nothing', () => {
    expect(chartable(asRuns(run('sensors/env', '{"temp":21}', '{"temp":22}')), 'humidity')).toMatchObject({
      reason: { code: 'no-field', field: 'humidity' },
    });
  });
});
