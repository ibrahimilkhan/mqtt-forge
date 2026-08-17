import type { LogEntry } from '../stores/logStore';

export type Reading = { value: number; at: Date };

export type Series = {
  topic: string;
  /** The path charted inside a JSON body, or null when the body is the number itself. */
  field: string | null;
  /** Oldest first, the way a chart is read. */
  readings: Reading[];
  /** Messages in view that carried no reading for this field, and were stepped over. */
  skipped: number;
  low: number;
  high: number;
};

/**
 * A body that is a number and nothing else.
 *
 * Number() is not the test: it takes '0x10' as sixteen, an empty body as zero and 'Infinity' as
 * a value no chart can place. A topic sending readings sends them written out, so the pattern
 * says so — sign, digits, a decimal point, an exponent, and nothing around them.
 */
const READING = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** Deep enough for the payloads people write, shallow enough that a hostile one cannot spin. */
const MAX_DEPTH = 6;

/** A payload with more numbers in it than this is a table, and a field list is not the way in. */
const MAX_FIELDS = 40;

/**
 * The readings behind a run of log entries, or null when there is no chart to draw.
 *
 * One line means one topic: a wildcard selection mixes topics, and °C and % share no axis. What
 * it does *not* insist on is a clean run — a sensor that says 'warming up' once between a
 * thousand readings is still a sensor, so unreadable messages are stepped over and counted. Past
 * half of them, though, the topic is not one sending readings with gaps: it is sending something
 * else that occasionally looks like a number, and a chart of it would be a chart of coincidences.
 */
export function numericSeries(entries: LogEntry[], field?: string | null): Series | null {
  if (entries.length < 2) return null;

  const topic = entries[0].topic;
  if (!topic || entries.some((entry) => entry.topic !== topic)) return null;

  const path = field === undefined ? pick(entries) : field;

  const readings: Reading[] = [];
  let low = Infinity;
  let high = -Infinity;

  // Newest first in the log; a chart is read left to right, oldest to newest.
  for (let i = entries.length - 1; i >= 0; i--) {
    const value = readingOf(entries[i], path);
    if (value === null) continue;

    readings.push({ value, at: entries[i].at });
    low = Math.min(low, value);
    high = Math.max(high, value);
  }

  // A chart of one point is a dot, and the row above it already shows that value in full.
  if (readings.length < 2 || readings.length * 2 < entries.length) return null;

  return { topic, field: path, readings, skipped: entries.length - readings.length, low, high };
}

/**
 * The numeric paths inside the JSON bodies, best covered first.
 *
 * A device that reports a whole environment in one message — temperature, humidity, pressure,
 * battery — is one topic with four charts in it, and which of them is wanted is the reader's
 * business rather than ours. The field most messages carry leads: it is both the likeliest and
 * the one whose chart will have the fewest gaps in it.
 */
export function numericFields(entries: LogEntry[]): string[] {
  const seen = new Map<string, number>();

  for (const entry of entries) {
    const body = parse(entry);
    if (body === null) continue;

    for (const path of paths(body, '', 0)) {
      seen.set(path, (seen.get(path) ?? 0) + 1);
      if (seen.size >= MAX_FIELDS) break;
    }
  }

  return [...seen.entries()]
    .sort(([nameA, countA], [nameB, countB]) => countB - countA || nameA.localeCompare(nameB))
    .map(([name]) => name);
}

/** Plain numbers when most of the run is plain numbers; otherwise the best covered field. */
function pick(entries: LogEntry[]): string | null {
  const plain = entries.filter((entry) => readingOf(entry, null) !== null).length;
  if (plain * 2 >= entries.length) return null;

  return numericFields(entries)[0] ?? null;
}

function readingOf(entry: LogEntry, path: string | null): number | null {
  // Binary is not a reading even where its hex parses: '10' as hex is the byte 0x10, and
  // plotting it as ten would put a number on the chart that never crossed the wire.
  if (!entry.body || entry.mode === 'hex') return null;

  if (path === null) return READING.test(entry.body.trim()) ? Number(entry.body) : null;

  const value = walk(parse(entry), path);

  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The parsed body when it is a JSON object or array, and null for everything else. */
function parse(entry: LogEntry): unknown {
  if (!entry.body || entry.mode === 'hex') return null;

  const body = entry.body.trim();
  if (!body.startsWith('{') && !body.startsWith('[')) return null;

  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function walk(body: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, segment) => {
    if (current === null || typeof current !== 'object') return undefined;

    return (current as Record<string, unknown>)[segment];
  }, body);
}

/** Every path in the body whose leaf is a number — booleans and strings are not readings. */
function paths(body: unknown, prefix: string, depth: number): string[] {
  if (depth >= MAX_DEPTH || body === null || typeof body !== 'object') return [];

  return Object.entries(body as Record<string, unknown>).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;

    if (typeof value === 'number' && Number.isFinite(value)) return [path];

    return paths(value, path, depth + 1);
  });
}
