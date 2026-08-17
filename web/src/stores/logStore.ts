import { create } from 'zustand';
import { describeError } from '../lib/problemDetails';
import type { BodyMode } from '../lib/payload';
import type { DecodedMessage } from '../realtime/decodeIncoming';

/**
 * What the log holds in total. Sized against the cost of reading it, not memory: the pane
 * re-filters the whole log on every frame that carries traffic, which at this size measures
 * well under a millisecond.
 */
export const MAX_LOG_ENTRIES = 5000;

/**
 * The run of history a topic keeps however crowded the broker is. Breadth alone is not a log:
 * at one line per topic, every arrival erases the line before it and there is nothing to read.
 * When the broker has few enough topics to afford more, they get more — this is the floor.
 */
export const MIN_TOPIC_ENTRIES = 25;

type LogKind = 'recv' | 'sent' | 'ok' | 'fault';

// 'recv' comes from the hub; the rest come from command results.
export type LogEntry = {
  id: number;
  kind: LogKind;
  at: Date;
  verb: string;
  topic?: string;
  body?: string;
  stamps?: string[];
  // Kept apart from the display stamps so re-publishing an entry doesn't mean parsing its labels.
  qos?: number;
  retain?: boolean;
  /** How `body` is written. Absent means text, which is what every entry was before hex. */
  mode?: BodyMode;
};

type NewLogEntry = Omit<LogEntry, 'id' | 'at'>;

type LogState = {
  entries: LogEntry[];
  push: (entry: NewLogEntry) => void;
  appendReceived: (messages: DecodedMessage[]) => void;
  clear: () => void;
};

let nextId = 0;

export const useLogStore = create<LogState>((set) => ({
  entries: [],

  push: (entry) =>
    set((state) => ({ entries: cap([{ ...entry, id: nextId++, at: new Date() }, ...state.entries]) })),

  appendReceived: (messages) =>
    set((state) => ({ entries: cap([...messages.map(toEntry).reverse(), ...state.entries]) })),

  clear: () => set({ entries: [] }),
}));

/**
 * Every failed command reaches the log the same way: what was attempted, and why it did not
 * happen. Kept here so the seven callers cannot each word it slightly differently.
 */
export const logFault = (verb: string, error: unknown, topic?: string) =>
  useLogStore.getState().push({ kind: 'fault', verb, topic, body: describeError(error) });

function toEntry(message: DecodedMessage): LogEntry {
  const stamps = [`QoS ${message.qos}`];
  if (message.retain) stamps.push('RETAINED');
  stamps.push(payloadSize(message.size));
  if (message.mode === 'hex') stamps.push('BIN');

  return {
    id: nextId++,
    kind: 'recv',
    at: new Date(message.receivedAt),
    // An arrow rather than 'Received': this is the only verb on every inbound row, and a log is
    // read by scanning the topics down it, so the mark saying which way a message went should
    // take the least room it can and still say it — a glyph reads at a glance where even a word
    // of two letters has to be read. Down is from the broker, up is to it; the row hands the
    // long word to a title. The commands keep their words: they arrive one at a time, are read
    // rather than scanned, and 'Connect failed' has no arrow in it.
    verb: '↓',
    topic: message.topic,
    body: message.payload,
    stamps,
    qos: message.qos,
    retain: message.retain,
    mode: message.mode,
  };
}

// Counted where the bytes were still bytes: a hex body is two characters per byte, so measuring
// the string here would double every binary arrival. No space before the unit: the stamp sits in
// a line of them now, and '8 b' read as two things where '8b' reads as one.
function payloadSize(bytes: number): string {
  return bytes < 1024 ? `${bytes}B` : `${(bytes / 1024).toFixed(1)}kB`;
}

// Bounds growth from a '#' subscription on a busy broker.
const cap = (entries: LogEntry[]) => (entries.length > MAX_LOG_ENTRIES ? trim(entries) : entries);

/**
 * Drops the overflow per topic rather than off the tail.
 *
 * The log is read one topic at a time, so a plain tail-drop is the wrong shape: one topic under
 * steady traffic fills every slot, and every other topic in the tree — each with real traffic
 * behind it — reads as silent. So each topic gets its own allowance and only the topics over it
 * lose anything. Command entries share one allowance between them: they carry no topic, and a
 * burst of faults should not crowd out messages either.
 *
 * What a crowded broker costs is breadth, not depth. Once every topic holds its floor there may
 * be no room left, and the walk below stops — so the topics that go are the ones whose newest
 * message is oldest, which are the ones nobody is watching. A topic still on screen keeps its
 * run of history intact.
 */
function trim(entries: LogEntry[]): LogEntry[] {
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.topic ?? '', (counts.get(entry.topic ?? '') ?? 0) + 1);

  const allowance = Math.max(MIN_TOPIC_ENTRIES, shareOut([...counts.values()]));

  const taken = new Map<string, number>();
  const kept: LogEntry[] = [];

  // Newest first, so what a topic loses is always its oldest.
  for (const entry of entries) {
    if (kept.length === MAX_LOG_ENTRIES) break;

    const key = entry.topic ?? '';
    const already = taken.get(key) ?? 0;
    if (already >= allowance) continue;

    taken.set(key, already + 1);
    kept.push(entry);
  }

  return kept;
}

/**
 * The largest per-topic allowance the cap affords: the level a tank fills to when the budget is
 * poured over the topics, so topics under it keep everything and only the ones above it are cut
 * back. Two loud topics get half the log each. Below MIN_TOPIC_ENTRIES the answer stops being
 * useful and the caller takes the floor instead.
 */
function shareOut(counts: number[]): number {
  const ascending = counts.sort((a, b) => a - b);

  let spent = 0;
  for (let i = 0; i < ascending.length; i++) {
    const above = ascending.length - i; // topics holding at least this many
    if (spent + ascending[i] * above > MAX_LOG_ENTRIES) {
      // Never zero: one line of a topic is what tells the pane it is not silent.
      return Math.max(1, Math.floor((MAX_LOG_ENTRIES - spent) / above));
    }
    spent += ascending[i];
  }

  return ascending[ascending.length - 1];
}
