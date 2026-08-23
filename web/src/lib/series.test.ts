import { describe, expect, it } from 'vitest';
import type { LogEntry } from '../stores/logStore';
import { MAX_PLOT, numericFields, numericSeries } from './series';

let nextId = 0;

// Newest first, the order the log holds them in.
const entries = (topic: string, ...bodies: Array<string | undefined>): LogEntry[] =>
  bodies
    .map((body, index) => ({
      id: nextId++,
      kind: 'recv' as const,
      at: new Date(2026, 0, 1, 12, 0, index).getTime(),
      topic,
      body,
    }))
    .reverse();

const values = (topic: string, ...bodies: Array<string | undefined>) =>
  numericSeries(entries(topic, ...bodies))?.readings.map((reading) => reading.value);

describe('numericSeries', () => {
  it('reads the bodies as numbers, oldest first', () => {
    expect(values('sensors/temp', '21.5', '22', '20.75')).toEqual([21.5, 22, 20.75]);
  });

  it('carries the time each reading arrived', () => {
    const series = numericSeries(entries('sensors/temp', '1', '2'));

    expect(series?.readings.map((reading) => reading.at.getSeconds())).toEqual([0, 1]);
  });

  it('reports the topic and the range the readings cover', () => {
    expect(numericSeries(entries('sensors/temp', '21.5', '19', '24'))).toMatchObject({
      topic: 'sensors/temp',
      field: null,
      low: 19,
      high: 24,
    });
  });

  it('takes negatives, decimals and exponents', () => {
    expect(values('sensors/temp', '-3', '.5', '1e3')).toEqual([-3, 0.5, 1000]);
  });

  // The point of the tolerance: one status message in a week of readings is not a reason to stop
  // charting a sensor. What was left out is counted, so the note can say so rather than hide it.
  it('steps over a message it cannot read rather than giving up on the topic', () => {
    const series = numericSeries(entries('sensors/temp', '21.5', 'sensor warming up', '22', '22.5'));

    expect(series?.readings.map((reading) => reading.value)).toEqual([21.5, 22, 22.5]);
    expect(series?.skipped).toBe(1);
  });

  it('counts a binary message as one it stepped over, not as a reading', () => {
    const [newest, ...rest] = entries('sensors/temp', '21.5', '22', '10');

    expect(numericSeries([{ ...newest, mode: 'hex' }, ...rest])).toMatchObject({
      skipped: 1,
      readings: [{ value: 21.5 }, { value: 22 }],
    });
  });

  // It used to give up here, and the reader got a refusal that named no topic and no reason.
  // Two readings are a line; what the chart owes the reader is the fact that most of what the
  // topic sent is not on it.
  it('draws what it can of a topic that mostly sends something else, and says so', () => {
    expect(numericSeries(entries('sensors/state', '1', 'ON', 'OFF', '2', 'ON'))).toMatchObject({
      readings: [{ value: 1 }, { value: 2 }],
      skipped: 3,
      sparse: true,
    });
  });

  it('does not call a run with the odd gap in it sparse', () => {
    expect(numericSeries(entries('sensors/temp', '21.5', 'warming up', '22'))).toMatchObject({
      sparse: false,
    });
  });

  // Number() would take these, and each would be a lie: '0x10' is not sixteen on a wire that
  // wrote it as text, an empty body is not zero, and a chart cannot plot an infinity.
  it.each(['0x10', '', '   ', 'Infinity', 'NaN', '1,5', '21.5 C'])('refuses %o as a reading', (body) => {
    expect(values('sensors/temp', '1', '2', '3', body)).toEqual([1, 2, 3]);
  });

  it('draws nothing from a single reading', () => {
    expect(numericSeries(entries('sensors/temp', '21.5'))).toBeNull();
  });

  // A wildcard selection mixes topics, and °C and % share no axis. One line means one topic.
  it('draws nothing when the entries span more than one topic', () => {
    const mixed = [...entries('sensors/temp', '21.5', '22'), ...entries('sensors/hum', '54')];

    expect(numericSeries(mixed)).toBeNull();
  });

  it('draws nothing from an empty log', () => {
    expect(numericSeries([])).toBeNull();
  });

  // Two hundred and fifty pixels of pane cannot draw five thousand readings — twenty of them
  // would share a pixel — and the arithmetic under the chart would be redone over all of them on
  // every arrival. The newest are the ones a console is for.
  it('charts the newest of a very long run and says how long the run was', () => {
    const long = entries('sensors/temp', ...Array.from({ length: MAX_PLOT + 500 }, (_, i) => `${i}`));
    const series = numericSeries(long)!;

    expect(series.readings).toHaveLength(MAX_PLOT);
    expect(series.readings[series.readings.length - 1].value).toBe(MAX_PLOT + 499);
    expect(series.of).toBe(MAX_PLOT + 500);
  });

  it('says nothing about a window when it charted everything', () => {
    expect(numericSeries(entries('sensors/temp', '1', '2', '3'))!.of).toBeNull();
  });
});

describe('numericSeries over JSON bodies', () => {
  const json = (...bodies: object[]) =>
    entries('sensors/env', ...bodies.map((body) => JSON.stringify(body)));

  it('charts a field of a JSON body', () => {
    const series = numericSeries(json({ temp: 21.5 }, { temp: 22 }, { temp: 20 }));

    expect(series?.field).toBe('temp');
    expect(series?.readings.map((reading) => reading.value)).toEqual([21.5, 22, 20]);
  });

  // A battery falling four thousandths of a volt and a humidity swinging ten per cent are both
  // 'changing'; only one of them is a chart worth opening on.
  it('opens on the field that moves the most against its own size', () => {
    const series = numericSeries(
      json(
        { battery: 3.9, hum: 50, temp: 21 },
        { battery: 3.899, hum: 55, temp: 21.1 },
        { battery: 3.898, hum: 45, temp: 20.9 },
      ),
    );

    expect(series?.field).toBe('hum');
  });

  it('charts the field it is given rather than the one it would have picked', () => {
    const series = numericSeries(json({ temp: 21.5, hum: 54 }, { temp: 22, hum: 55 }), 'hum');

    expect(series?.readings.map((reading) => reading.value)).toEqual([54, 55]);
  });

  it('reaches a nested field by its path', () => {
    const series = numericSeries(json({ env: { temp: 21.5 } }, { env: { temp: 22 } }), 'env.temp');

    expect(series?.readings.map((reading) => reading.value)).toEqual([21.5, 22]);
  });

  it('reaches into an array by position', () => {
    const series = numericSeries(json({ cells: [3.7, 3.8] }, { cells: [3.6, 3.9] }), 'cells.1');

    expect(series?.readings.map((reading) => reading.value)).toEqual([3.8, 3.9]);
  });

  it('steps over a message where the field is missing', () => {
    const series = numericSeries(json({ temp: 21.5 }, { hum: 54 }, { temp: 22 }, { temp: 23 }), 'temp');

    expect(series?.skipped).toBe(1);
    expect(series?.readings.map((reading) => reading.value)).toEqual([21.5, 22, 23]);
  });

  it('steps over a message that is not JSON at all', () => {
    const mixed = entries('sensors/env', '{"temp":21.5}', 'restarting', '{"temp":22}', '{"temp":23}');

    expect(numericSeries(mixed, 'temp')).toMatchObject({ skipped: 1 });
  });
});

describe('numericFields', () => {
  const json = (...bodies: object[]) =>
    entries('sensors/env', ...bodies.map((body) => JSON.stringify(body)));

  it('offers the numeric fields of the bodies', () => {
    expect(numericFields(json({ temp: 21.5, hum: 54 }))).toEqual(['hum', 'temp']);
  });

  it('offers nested fields by path, and array entries by position', () => {
    expect(numericFields(json({ env: { temp: 21.5 }, cells: [3.7] }))).toEqual(['cells.0', 'env.temp']);
  });

  // A chart of a string is not a chart, and 0/1 for a flag is a reading nobody sent.
  it('leaves out the fields that are not numbers', () => {
    expect(numericFields(json({ temp: 21.5, state: 'ON', live: true, spare: null }))).toEqual(['temp']);
  });

  // The field most of the messages carry is the one most likely to be wanted, and the one whose
  // chart will have the fewest gaps in it.
  it('offers the best covered field first', () => {
    expect(numericFields(json({ temp: 21.5 }, { temp: 22, hum: 54 }, { temp: 23 }))).toEqual([
      'temp',
      'hum',
    ]);
  });

  it('offers nothing for bodies that are plain numbers', () => {
    expect(numericFields(entries('sensors/temp', '21.5', '22'))).toEqual([]);
  });

  it('offers nothing for bodies that are not JSON', () => {
    expect(numericFields(entries('sensors/state', 'ON', 'OFF'))).toEqual([]);
  });
});
