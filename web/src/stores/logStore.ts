import { create } from 'zustand';
import { useBrokerEventsStore } from './brokerEventsStore';
import { describeError } from '../lib/problemDetails';
import { matchesFilter } from '../lib/topicMatch';
import type { BodyMode } from '../lib/payload';
import type { DecodedMessage } from '../realtime/decodeIncoming';
import type { MessageProperties } from '../types/api';
import { TopicRing } from './topicRing';

/**
 * The longest run a topic keeps when the console can afford it.
 *
 * The log used to be one list of the newest messages from the whole broker, and that made a
 * topic's history a matter of what everything else was doing: a tram that finished its journey
 * had its messages pushed out by traffic on other topics within a couple of minutes, so the
 * tree went on counting them while the pane said none had ever arrived. A run per topic ends
 * that — nothing another topic does can shorten this one.
 *
 * Four times MAX_PLOT, deliberately. The chart draws the newest five hundred readings and its
 * note says how many more are behind them; at a depth of five hundred there never were any, and
 * a whole reading of the pane — 'there is more here than I am being shown' — quietly stopped
 * being true.
 *
 * A ceiling this generous is only affordable because breadth takes it back: a broker with
 * thousands of topics has every run narrowed to what MAX_LOG_ENTRIES affords, so this is the
 * depth a small broker gets rather than a promise made to every broker.
 */
export const TOPIC_DEPTH = 2000;

/**
 * And how much weight — but only once the console is full.
 *
 * This used to bound every run all the time, and it was the wrong shape of answer: a topic
 * sending megabyte payloads on a console holding forty megabytes was giving up its history to
 * save memory nobody needed saving. A count is still not a memory bound, so the bound is real;
 * it is just held in reserve and applied to every run at once when the log as a whole passes
 * LOAD_BYTES below. Until then a run is bounded by TOPIC_DEPTH and nothing else, and a topic
 * sending megabytes keeps them.
 *
 * MQTT Explorer bounds its own history at a hundred messages or twenty kilobytes, always. This
 * is far more generous on both, and only under pressure.
 */
export const TOPIC_BYTES = 256 * 1024;

/**
 * How much the console may hold before it starts cutting runs back, in the characters bodies are
 * held as — the reader's own answer to 'how much of this machine may a console watching a plant
 * take', chosen in Settings and stored with the other choices.
 *
 * Five hundred megabytes by default. It is a great deal to give a console, and that is the point:
 * the caps under it exist for the machine, not for tidiness, so nothing should be thrown away
 * while there is room for it. A console watching an ordinary broker never reaches this and so
 * never loses a message at all; one pointed at a plant sending megabyte images fills it in
 * minutes, and then the per-topic weight above comes on and every run keeps its newest quarter
 * of a megabyte.
 *
 * Characters rather than bytes, like every weight here: a proxy that needs nothing decoded to
 * be taken. For text it is the same number; for a hex body it is about twice the wire size.
 */
export const DEFAULT_LOAD_BYTES = 500 * 1024 * 1024;

/**
 * The most the log holds across every topic, and the only bound that is about the machine
 * rather than about one topic.
 *
 * It used to be five thousand, and that was a reading budget rather than a memory one: the pane
 * re-filtered the whole log on every frame that carried traffic, so the cost of an arrival grew
 * with how much history was kept. Measured against a broker with two thousand topics and the deep
 * names a real one has, one read cost 4.5ms at five thousand entries and 174ms at two hundred
 * thousand — which is why the number had to stay small, and why an hour of history was not on
 * offer from a tool meant to watch a plant. `byTopic` took that cost out: the same read is 1.8ms
 * at two hundred thousand entries, and flat — set by the run asked for, not by the log behind it.
 * So this is a memory budget now rather than a reading one.
 *
 * The one cost that does still grow with it is a selection covering every topic at once, which
 * has to gather everything it matches whatever holds it: about 6ms here, inside a frame.
 *
 * Reached by breadth rather than by depth: a broker with more topics than this affords at
 * TOPIC_DEPTH has every run narrowed to what fits, down to MIN_TOPIC_ENTRIES, rather than
 * losing topics. Depth is what gives way, because a topic the log has thrown away entirely is
 * the fault this shape was built to end.
 *
 * Half a million rather than the million first tried, and the reason is memory measured rather
 * than estimated: a million of these costs about 460MB with the payloads a real broker sends,
 * which is more than a console watching a plant should ask of the machine it is watching from.
 * Half that is about 230MB, and at fifty messages a second it is still close to three hours of
 * history where the first version of this log held a hundred seconds.
 *
 * There is a cheaper million available and it is not taken here: `at` is a Date on every entry
 * and costs about 86 bytes each for something only ever rendered as a time, and the stamps are
 * built up front rather than when a row is drawn. Together they are more than a third of what
 * an entry weighs, measured. Worth having, and a different change from this one.
 *
 * `size` was added to that ledger deliberately: a number on every entry is about eight bytes,
 * so four megabytes at the cap. It buys the one field a window opening a message cannot work
 * out for itself, and the alternative was parsing it back out of a word like '1.2kB'.
 */
export const MAX_LOG_ENTRIES = 500_000;

/**
 * How many commands the log remembers.
 *
 * Kept apart from the traffic and kept small. Commands are what this console did — subscribed,
 * published, failed — and there are a handful a minute at most, so they neither need a topic's
 * ring nor should be evicted by one.
 */
export const MAX_COMMANDS = 500;

/**
 * The run of history a topic keeps however crowded the broker is. Now the floor under
 * TOPIC_DEPTH rather than a per-topic share of one budget, and still what the pane steps
 * through history by.
 */
export const MIN_TOPIC_ENTRIES = 25;

type LogKind = 'recv' | 'ok' | 'fault';

// 'recv' comes from the hub; the rest come from command results. A publish writes nothing here:
// the log is the record of what the broker sent, and a message this client sent comes back down
// the subscription as an arrival like any other, or was never traffic at all.
export type LogEntry = {
  id: number;
  kind: LogKind;
  at: Date;
  /** What a command did, in words. An arrival has none: the pane holds nothing else. */
  verb?: string;
  topic?: string;
  body?: string;
  stamps?: string[];
  // Kept apart from the display stamps so re-publishing an entry doesn't mean parsing its labels.
  qos?: number;
  retain?: boolean;
  /** How `body` is written. Absent means text, which is what every entry was before hex. */
  mode?: BodyMode;
  /**
   * What the payload weighed on the wire, in bytes.
   *
   * Kept because it cannot be recovered: a hex body is two characters and a space per byte, so
   * measuring `body` doubles every binary arrival, and `stamps` holds it only as the words '4B'.
   * A window that opens one message has to be able to say 1024 bytes.
   */
  size?: number;
  /**
   * What MQTT 5 sent with the message.
   *
   * Absent on nearly every entry — every one on a 3.1.1 link, and most on a 5.0 one — so it costs
   * a run of five thousand messages one undefined field each rather than an object each.
   */
  properties?: MessageProperties;
};

type NewLogEntry = Omit<LogEntry, 'id' | 'at'>;

export type LogState = {
  /**
   * What this console did, newest first: subscribed, published, and what failed.
   *
   * Apart from the traffic because it is a different thing asked a different way — the pane
   * reads arrivals by topic and reads these to explain a silence — and because a burst of
   * faults should not be able to push a topic's history out, nor the other way round.
   */
  commands: LogEntry[];
  /**
   * The traffic, one bounded run per topic.
   *
   * This is the log now. There is no second list holding every arrival in one sequence: that
   * list was what made an arrival cost more the longer the console had been running, and what
   * made a quiet topic's history the property of every other topic's traffic.
   *
   * Mutated in place, deliberately — rebuilding a map of thousands of topics on every batch
   * would be the very cost this removes. `version` is what says something changed.
   */
  byTopic: Map<string, TopicRing>;
  /** How many arrivals are held across every topic, for the ceiling above. */
  held: number;
  /**
   * And what they weigh, in the characters their bodies are held as.
   *
   * Kept running rather than walked, unlike everything else here that could be counted on
   * demand: the budget has to be checked on the message that crosses it, and walking every ring
   * to find that out would put the whole map on the path of every arrival. What it costs instead
   * is one subtraction and one addition per message.
   */
  weight: number;
  /** What the reader allows the console to hold, in those same characters. */
  budget: number;
  /**
   * Whether the per-topic weight cap is on — the console has been over its budget and every run
   * is bounded by TOPIC_BYTES until the reader gives it more room.
   */
  capped: boolean;
  /** Sets what the console may hold, and cuts back — or lets grow again — at once. */
  setBudget: (bytes: number) => void;
  /** Bumped on every change, because the two structures above are mutated rather than replaced. */
  version: number;
  push: (entry: NewLogEntry) => void;
  appendReceived: (messages: DecodedMessage[]) => void;
  clear: () => void;
  /**
   * Drops the runs of topics the tree has given up.
   *
   * The two structures hold one thing between them — a topic's row and that topic's readings —
   * and a reader who clicks a row to find nothing, or a run nothing on screen can reach, is worse
   * off than if both had gone. The tree's ceiling is the one that fires here; the log's own
   * eviction is a different budget and answers to itself.
   */
  forgetTopics: (topics: readonly string[]) => void;
  /**
   * Cuts the runs of these topics back to their newest message.
   *
   * What a reader means by clearing a pane and keeping the value on it: the history goes, the
   * reading stays, and the topic goes on collecting as deeply as it did before — see
   * TopicRing.keepNewest, which is careful not to leave a ceiling behind.
   */
  keepNewestOn: (topics: readonly string[]) => void;
};

let nextId = 0;

export const useLogStore = create<LogState>((set) => ({
  commands: [],
  byTopic: new Map(),
  held: 0,
  weight: 0,
  budget: DEFAULT_LOAD_BYTES,
  capped: false,
  version: 0,

  push: (entry) =>
    set((state) => {
      const written = { ...entry, id: nextId++, at: new Date() };

      // An arrival can arrive this way too — the renderer seeds the console with them — and it
      // belongs with the traffic wherever it came from.
      if (written.kind === 'recv' && written.topic) {
        return { ...file(state, written, state), version: state.version + 1 };
      }

      // Every command is a broker event as well, and the events are where it outlives this log:
      // the next connection clears the commands, and the line saying what the last one did goes
      // with them. See brokerEventsStore.
      useBrokerEventsStore.getState().push({
        // Past the arrival test above, so 'recv' is not a value this can be — the type just
        // does not know it.
        kind: written.kind === 'fault' ? 'fault' : 'ok',
        what: written.topic ? `${written.verb ?? ''} · ${written.topic}` : (written.verb ?? ''),
        detail: written.body,
      });

      return {
        commands: [written, ...state.commands].slice(0, MAX_COMMANDS),
        version: state.version + 1,
      };
    }),

  appendReceived: (messages) =>
    set((state) => {
      let load: Load = state;
      for (const message of messages) load = file(state, toEntry(message), load);

      return { ...load, version: state.version + 1 };
    }),

  forgetTopics: (topics) =>
    set((state) => {
      if (topics.length === 0) return state;

      let held = state.held;
      let weight = state.weight;
      for (const topic of topics) {
        const ring = state.byTopic.get(topic);
        if (!ring) continue;

        held -= ring.length;
        weight -= ring.weight;
        state.byTopic.delete(topic);
      }

      return {
        held: Math.max(0, held),
        weight: Math.max(0, weight),
        version: state.version + 1,
      };
    }),

  keepNewestOn: (topics) =>
    set((state) => {
      if (topics.length === 0) return state;

      let held = state.held;
      let weight = state.weight;
      for (const topic of topics) {
        const ring = state.byTopic.get(topic);
        if (!ring || ring.length <= 1) continue;

        const wasLong = ring.length;
        const wasHeavy = ring.weight;
        ring.keepNewest();
        held -= wasLong - ring.length;
        weight -= wasHeavy - ring.weight;
      }

      return {
        held: Math.max(0, held),
        weight: Math.max(0, weight),
        version: state.version + 1,
      };
    }),

  clear: () =>
    set((state) => {
      state.byTopic.clear();

      return {
        commands: [],
        held: 0,
        weight: 0,
        // A console holding nothing is not a console under pressure. The runs it fills up with
        // next are bounded by the count alone again, as they were before it ever filled.
        capped: false,
        version: state.version + 1,
      };
    }),

  setBudget: (bytes) =>
    set((state) => {
      // Said again rather than changed. This is called on every stored-choice change, not only
      // on this one, so the common case is a reader picking a font.
      if (bytes === state.budget) return {};

      // More room than there was, and enough of it: runs cut back under the old budget are free
      // to grow again. Only on the way up — a console under pressure is under it until the
      // reader says otherwise, and weight falling below the budget is what cutting back *does*.
      if (bytes > state.budget && state.capped && bytes > state.weight) {
        for (const ring of state.byTopic.values()) ring.capBytesTo(Number.POSITIVE_INFINITY);

        return { budget: bytes, capped: false, version: state.version + 1 };
      }

      if (state.weight <= bytes) return { budget: bytes, version: state.version + 1 };

      return { ...cutBack(state, bytes), budget: bytes, version: state.version + 1 };
    }),
}));

/** What the console is carrying: how many, what they weigh, and whether it is over its budget. */
type Load = { held: number; weight: number; capped: boolean };

/**
 * Puts an arrival in its topic's run, and keeps the console inside its ceilings.
 *
 * The load is passed in rather than read off the state: a batch files its messages one after
 * another before the state is replaced, so the state's own counts are the ones from before the
 * batch started and every message in the batch but the last would be counted away.
 */
function file(state: LogState, entry: LogEntry, load: Load): Load {
  const topic = entry.topic!;
  let ring = state.byTopic.get(topic);
  if (!ring) {
    // A topic first heard from while the console is full is bounded like the rest of them.
    ring = new TopicRing({
      maxItems: TOPIC_DEPTH,
      maxBytes: load.capped ? TOPIC_BYTES : Number.POSITIVE_INFINITY,
    });
    state.byTopic.set(topic, ring);
  }

  const wasLong = ring.length;
  const wasHeavy = ring.weight;
  ring.push(entry);

  let held = load.held + (ring.length - wasLong);
  let weight = load.weight + (ring.weight - wasHeavy);

  if (held > MAX_LOG_ENTRIES) {
    held = narrowRuns(state.byTopic, held);
    // Runs were cut to fit a count, which is a different measure; what that left them weighing
    // has to be counted rather than guessed, and the walk it costs has just been paid anyway.
    weight = heldWeight(state.byTopic);
  }

  return weight > state.budget
    ? cutBack(state, state.budget)
    : { held, weight, capped: load.capped };
}

/**
 * Brings the console back inside its memory budget.
 *
 * This is where the per-topic weight cap comes on, and it comes on for every run at once. It is
 * the bound the log holds in reserve: until the whole of it is over budget, a topic sending
 * megabyte payloads keeps them, because there was room.
 *
 * Depth gives way before breadth here too — every run keeps its newest TOPIC_BYTES rather than
 * some topics keeping everything and the rest nothing. Only when even that is more than the
 * budget do whole topics go, and the ones that go are those whose newest message is oldest: a
 * topic still moving is one somebody may be watching.
 */
function cutBack(state: LogState, budget: number): Load {
  let held = 0;
  let weight = 0;
  for (const ring of state.byTopic.values()) {
    ring.capBytesTo(TOPIC_BYTES);
    held += ring.length;
    weight += ring.weight;
  }

  if (weight <= budget) return { held, weight, capped: true };

  const byAge = [...state.byTopic.entries()].sort((a, b) => a[1].newestId - b[1].newestId);
  for (const [topic, ring] of byAge) {
    if (weight <= budget) break;
    held -= ring.length;
    weight -= ring.weight;
    state.byTopic.delete(topic);
  }

  return { held: Math.max(0, held), weight: Math.max(0, weight), capped: true };
}

/**
 * Brings the console back inside its ceiling by making every run shorter.
 *
 * Depth is what gives way, not breadth. Dropping whole topics was the first thing tried and it
 * is exactly the fault this shape was built to end: a topic the log had thrown away entirely
 * still stands in the tree with its count, and clicking it says nothing ever arrived. Every
 * topic keeps a run — down to MIN_TOPIC_ENTRIES, below which a run stops being one — and the
 * console holds fewer messages each rather than none for some.
 *
 * Only reached by breadth: a broker with more topics than the ceiling affords at TOPIC_DEPTH.
 * It walks the topics rather than the messages, so it is cheap even then.
 */
export function narrowRuns(
  byTopic: Map<string, TopicRing>,
  held: number,
  // A parameter so the rule can be exercised without a million messages; the console never
  // passes anything but its own ceiling.
  ceiling: number = MAX_LOG_ENTRIES,
): number {
  if (held <= ceiling || byTopic.size === 0) return held;

  const share = Math.max(MIN_TOPIC_ENTRIES, Math.floor(ceiling / byTopic.size));

  let now = 0;
  for (const ring of byTopic.values()) {
    ring.narrowTo(share);
    now += ring.length;
  }

  return now > ceiling ? evictQuietest(byTopic, now, ceiling) : now;
}

/**
 * The last resort, when even the shortest run each is more than the console can hold — a broker
 * with more topics than MAX_LOG_ENTRIES / MIN_TOPIC_ENTRIES, which is tens of thousands.
 *
 * The ones that go are those whose newest message is oldest: a topic still moving is one
 * somebody may be watching.
 */
function evictQuietest(byTopic: Map<string, TopicRing>, held: number, ceiling: number): number {
  const byAge = [...byTopic.entries()]
    .map(([topic, ring]) => ({ topic, ring, newest: ring.newestId }))
    .sort((a, b) => a.newest - b.newest);

  for (const { topic, ring } of byAge) {
    if (held <= ceiling) break;
    held -= ring.length;
    byTopic.delete(topic);
  }

  return held;
}

/**
 * Every failed command reaches the log the same way: what was attempted, and why it did not
 * happen. Kept here so the seven callers cannot each word it slightly differently.
 */
export const logFault = (verb: string, error: unknown, topic?: string) =>
  useLogStore.getState().push({ kind: 'fault', verb, topic, body: describeError(error) });

/**
 * What a chip means, where the word alone reads as an answer to a different question.
 *
 * Two of the stamps on an arrival are facts about the *delivery* and are read as verdicts on the
 * publish behind it. A reader who publishes at QoS 2 with Retain ticked, and is subscribed to
 * what they sent, gets a row back stamped `QoS 0` and a window stamped `not retained` — both true
 * of the copy in front of them, neither true of what went out. The rules are MQTT's: a
 * subscription caps the QoS of every copy sent under it, and a broker clears the retain bit on
 * every copy it forwards to a subscription that was already up.
 *
 * One place decides what a chip says, so one place says what it means: the log row and the
 * window bar both read from here.
 */
export function stampMeaning(stamp: string): string | undefined {
  if (stamp.startsWith('QoS'))
    return 'The QoS this copy was delivered at. A subscription caps the QoS of every copy sent under it, so a QoS 2 publish arrives at QoS 0 on a QoS 0 subscription — and this console listens to everything at QoS 0.';

  if (stamp === 'RETAINED')
    return 'The broker sent this copy out of the message it had stored, because a subscription had just been made.';

  if (stamp === 'not retained')
    return 'This copy was not marked retained. A broker clears that flag on every message it forwards to a subscription that was already up, whatever the publisher asked for.';

  return undefined;
}

function toEntry(message: DecodedMessage): LogEntry {
  const stamps = [`QoS ${message.qos}`];
  if (message.retain) stamps.push('RETAINED');
  stamps.push(payloadSize(message.size));
  if (message.mode === 'hex') stamps.push('BIN');

  return {
    id: nextId++,
    kind: 'recv',
    at: new Date(message.receivedAt),
    // No verb, and no arrow standing in for one. The pane holds arrivals and nothing else now,
    // so a mark on every row saying 'this one arrived' distinguished it from nothing — it was
    // read once and then became a column of identical glyphs to look past. The commands keep
    // their words: they say what was attempted, which is not something the row shows otherwise.
    topic: message.topic,
    body: message.payload,
    stamps,
    qos: message.qos,
    retain: message.retain,
    mode: message.mode,
    // Counted where the bytes were still bytes — see payloadSize below, and `size` on the type.
    size: message.size,
    properties: message.properties,
  };
}

// Counted where the bytes were still bytes: a hex body is two characters per byte, so measuring
// the string here would double every binary arrival. No space before the unit: the stamp sits in
// a line of them now, and '8 b' read as two things where '8b' reads as one.
function payloadSize(bytes: number): string {
  return bytes < 1024 ? `${bytes}B` : `${(bytes / 1024).toFixed(1)}kB`;
}

/**
 * What the log holds on one filter, newest first.
 *
 * Two steps rather than one scan: which topics the filter covers, and then their runs. The
 * first is asked of the topics, the second copies without matching anything — so the work is
 * set by how much the reader asked for, not by how much the log happens to be holding.
 *
 * A filter covering one topic is the ordinary case — every leaf in the tree selects `path/#` —
 * and it is answered by reading one run. Several are merged on `id`, which only ever goes up,
 * so it orders arrivals across topics exactly as they arrived.
 */
export function runFor(byTopic: ReadonlyMap<string, TopicRing>, filter: string): LogEntry[] {
  const runs = runsFor(byTopic, filter);

  if (runs.length === 0) return [];
  if (runs.length === 1) return runs[0];

  const merged: LogEntry[] = [];
  for (const run of runs) merged.push(...run);

  return merged.sort((a, b) => b.id - a.id);
}

/**
 * What every run together weighs, in the characters their bodies are held as.
 *
 * The store keeps this running now — the budget has to be checked on the message that crosses
 * it, and walking every ring to find that out would put the whole map on the path of every
 * arrival. This is how it is put right after a pass that cut runs back by a different measure,
 * and it is what a test can check the running total against.
 */
export function heldWeight(byTopic: ReadonlyMap<string, TopicRing>): number {
  let weight = 0;
  for (const ring of byTopic.values()) weight += ring.weight;

  return weight;
}

/**
 * One sequence of arrivals, put back into a run per topic.
 *
 * For a run that is already fixed — a held pane — where grouping is paid once rather than on
 * every arrival, and the live path never needs it because the log holds the runs apart already.
 */
export function runsOf(entries: readonly LogEntry[]): LogEntry[][] {
  const byTopic = new Map<string, LogEntry[]>();

  for (const entry of entries) {
    if (entry.kind !== 'recv' || !entry.topic) continue;

    const run = byTopic.get(entry.topic);
    if (run) run.push(entry);
    else byTopic.set(entry.topic, [entry]);
  }

  return [...byTopic.values()];
}

/**
 * The same traffic, left as one run per topic.
 *
 * For readers that are going to group by topic anyway, which is the chart: it draws a plot per
 * topic, so the merge and the sort above were work done only to be undone — the run was
 * flattened into one sequence and then split back apart on the other side. Measured against
 * Helsinki's feed with a branch of fourteen thousand topics selected, that round trip was the
 * difference between a console that keeps up and one that stalls for two thirds of a second at
 * a time, on every batch, for as long as the selection is held.
 *
 * Each run is newest first, which is what a series wants: it takes its window off the front.
 */
export function runsFor(byTopic: ReadonlyMap<string, TopicRing>, filter: string): LogEntry[][] {
  if (!filter) return [];

  const runs: LogEntry[][] = [];
  for (const [topic, ring] of byTopic) {
    if (!matchesFilter(filter, topic)) continue;

    const run = ring.newestFirst();
    if (run.length > 0) runs.push(run);
  }

  return runs;
}
