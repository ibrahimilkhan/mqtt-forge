import { asReading } from './number';
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
  /** How long the run really is, when it was longer than one chart can hold; null otherwise. */
  of: number | null;
  low: number;
  high: number;
};

/** Deep enough for the payloads people write, shallow enough that a hostile one cannot spin. */
const MAX_DEPTH = 6;

/** A payload with more numbers in it than this is a table, and a field list is not the way in. */
const MAX_FIELDS = 40;

/**
 * How many of the newest messages are read to work out what a topic sends.
 *
 * Which fields a device reports does not change every second, so the answer is the same whether
 * it is drawn from the last two hundred messages or the last five thousand — and the difference
 * is a JSON parse of the whole log on every arrival.
 */
const SAMPLE = 200;

/**
 * The longest run a chart draws.
 *
 * Two hundred and fifty pixels of pane cannot show five thousand readings — twenty of them would
 * share a pixel — and every arrival would redo the whole summary over all of them. The newest
 * are what a console is for; the rest are still in the log, and the note says they are there.
 */
export const MAX_PLOT = 500;

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

  // The newest first in the log, so the window is taken off the front.
  const window = entries.length > MAX_PLOT ? entries.slice(0, MAX_PLOT) : entries;

  const readings: Reading[] = [];
  let low = Infinity;
  let high = -Infinity;

  // A chart is read left to right, oldest to newest.
  for (let i = window.length - 1; i >= 0; i--) {
    const value = readingOf(window[i], path);
    if (value === null) continue;

    readings.push({ value, at: window[i].at });
    low = Math.min(low, value);
    high = Math.max(high, value);
  }

  // A chart of one point is a dot, and the row above it already shows that value in full.
  if (readings.length < 2 || readings.length * 2 < window.length) return null;

  return {
    topic,
    field: path,
    readings,
    skipped: window.length - readings.length,
    of: entries.length > MAX_PLOT ? entries.length : null,
    low,
    high,
  };
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

  for (const entry of entries.slice(0, SAMPLE)) {
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

/**
 * What to chart when nobody has said.
 *
 * Plain numbers when most of the run is plain numbers. Otherwise the best covered field, and
 * among fields every message carries — which is the usual case, since a device reports the same
 * shape every time — the one that moves the most relative to its own size. An environment sensor
 * reporting temperature, humidity and a battery voltage should open on something that is doing
 * something, not on whichever of them comes first in the alphabet.
 */
function pick(entries: LogEntry[]): string | null {
  const sample = entries.slice(0, SAMPLE);
  const plain = sample.filter((entry) => readingOf(entry, null) !== null).length;
  if (plain * 2 >= sample.length) return null;

  const fields = numericFields(entries);
  if (fields.length < 2) return fields[0] ?? null;

  // Parsed once and read many times. A device reporting forty fields would otherwise have every
  // body parsed forty times over to answer a question about which of them to open on.
  const bodies = sample.map(parse);
  const readings = (field: string) =>
    bodies.map((body) => numberAt(body, field)).filter((value): value is number => value !== null);

  const runs = new Map(fields.map((field) => [field, readings(field)]));
  const best = Math.max(...fields.map((field) => runs.get(field)!.length));
  const tied = fields.filter((field) => runs.get(field)!.length === best);

  return tied.reduce((leader, field) =>
    movement(runs.get(field)!) > movement(runs.get(leader)!) ? field : leader,
  );
}

/**
 * How much a field moves, against how big it is.
 *
 * A battery falling four thousandths of a volt an hour and a humidity swinging ten per cent are
 * both 'changing'; only one of them is a chart worth opening on. Dividing by the middle puts
 * them on the same footing, and a field sitting at zero falls back to its plain spread.
 */
function movement(values: number[]): number {
  if (values.length < 2) return 0;

  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  const spread = Math.max(...values) - Math.min(...values);

  return Math.abs(mean) > 1e-9 ? spread / Math.abs(mean) : spread;
}

function readingOf(entry: LogEntry, path: string | null): number | null {
  // Binary is not a reading even where its hex parses: '10' as hex is the byte 0x10, and
  // plotting it as ten would put a number on the chart that never crossed the wire.
  if (!entry.body || entry.mode === 'hex') return null;

  if (path === null) return asReading(entry.body);

  return numberAt(parse(entry), path);
}

/** The number at a path inside an already-parsed body, or null where there is not one. */
function numberAt(body: unknown, path: string): number | null {
  const value = walk(body, path);

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
