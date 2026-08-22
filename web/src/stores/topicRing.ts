import type { LogEntry } from './logStore';

/**
 * What one topic keeps, and how much of it.
 *
 * Two bounds rather than one. A count alone says nothing about memory — a topic sending
 * megabyte payloads would hold the same five hundred as one sending twelve bytes — and a byte
 * budget alone gives a chatty small-payload topic a run so long the pane cannot use it. MQTT
 * Explorer's own history is bounded the same way, at a hundred messages or twenty kilobytes.
 */
export type RingBounds = { maxItems: number; maxBytes: number };

/**
 * A topic's run of history, oldest first, bounded and cheap to add to.
 *
 * Nothing is shifted or copied on the hot path. Arrivals are appended, and what falls off the
 * far end is let go by moving a start index rather than by moving every element after it — the
 * backing array is only ever compacted once a whole ring's worth has been dropped, so the work
 * of tidying is paid once per ring rather than once per message.
 *
 * Oldest first because that is the order arrivals come in; a reader wanting newest first pays
 * one reversal over the run they asked for, which is the size of the answer either way.
 */
export class TopicRing {
  private items: LogEntry[] = [];
  private start = 0;
  private bytes = 0;
  private bounds: RingBounds;

  constructor(bounds: RingBounds) {
    this.bounds = bounds;
  }

  get length(): number {
    return this.items.length - this.start;
  }

  /** What the run weighs, in the characters its bodies are held as. */
  get weight(): number {
    return this.bytes;
  }

  /** The id of the newest arrival held, or -1 when nothing is. Ids only go up, so this orders
   *  topics by how recently each last spoke without keeping a clock. */
  get newestId(): number {
    return this.items.length > this.start ? this.items[this.items.length - 1].id : -1;
  }

  push(entry: LogEntry): void {
    this.items.push(entry);
    this.bytes += weigh(entry);

    while (this.length > this.bounds.maxItems || (this.bytes > this.bounds.maxBytes && this.length > 1)) {
      this.dropOldest();
    }

    // Once as much has been dropped as the ring can hold, the dead prefix is worth the one
    // copy it costs to remove. Held to twice the bound, never growing without end.
    if (this.start >= this.bounds.maxItems) this.compact();
  }

  /**
   * Narrows what this run may hold, and cuts it back to fit at once.
   *
   * Depth gives way to breadth: a broker with thousands of topics cannot afford every one of
   * them the run a broker with ten can, and a shorter run on every topic is worth more than a
   * full run on some and nothing at all on the rest.
   */
  narrowTo(maxItems: number): void {
    this.bounds = { ...this.bounds, maxItems };
    while (this.length > maxItems) this.dropOldest();
    if (this.start >= maxItems) this.compact();
  }

  /** The run, newest first — the order every reader of it wants. */
  newestFirst(): LogEntry[] {
    const held = this.items.slice(this.start);
    held.reverse();

    return held;
  }

  private dropOldest(): void {
    const going = this.items[this.start];
    this.bytes -= weigh(going);
    // Cleared as well as skipped: a slot still pointing at an entry keeps its payload alive.
    this.items[this.start] = undefined as unknown as LogEntry;
    this.start++;
  }

  private compact(): void {
    this.items = this.items.slice(this.start);
    this.start = 0;
  }
}

// The payload as it is held, which is what the entry actually costs. Measured in characters
// rather than bytes: it is a proxy, and one that never has to decode anything to be taken.
const weigh = (entry: LogEntry): number => entry.body?.length ?? 0;
