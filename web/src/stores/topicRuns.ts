import type { TopicRing } from './topicRing';

/**
 * Every topic's run, and an order over them so a branch can be found rather than searched for.
 *
 * It stands in for the Map it used to be — the log holds one, and everything that reads it reads
 * it as a map — with one thing added: the topics in order, so a filter naming a branch is
 * answered by two binary searches instead of by asking the matcher about every topic there is.
 *
 * That question was the most expensive thing the console did. The pane and the chart both ask it
 * once per batch of arrivals, and `matchesFilter` splits both strings on every call: measured on
 * a broker with twenty thousand topics, finding the one run behind a selected leaf cost 15.2ms,
 * of which 15.1ms was the walk. It grew with the broker — 7.0ms at ten thousand topics, 36.0ms
 * at fifty thousand — so on a busy broker the console spent more of each frame looking for the
 * messages than it did taking them in. The same read is 0.001ms here, and flat.
 */
export class TopicRuns implements ReadonlyMap<string, TopicRing> {
  private runs = new Map<string, TopicRing>();

  /** The topics, sorted. Rebuilt only by `settle`. */
  private sorted: string[] = [];

  /**
   * Topics named since the last settle, in the order they first spoke.
   *
   * Held rather than spliced into place one at a time: a splice costs the length of the list,
   * and a broker names most of its topics in its first seconds, so that would be the list's
   * length paid thousands of times over. Merging a batch is one pass instead, and it only
   * happens when a reader asks — a broker that has finished naming itself settles once and
   * then never again.
   */
  private waiting: string[] = [];

  /** How many topics have been evicted since the last settle; see `settle`. */
  private gone = 0;

  get size(): number {
    return this.runs.size;
  }

  get(topic: string): TopicRing | undefined {
    return this.runs.get(topic);
  }

  has(topic: string): boolean {
    return this.runs.has(topic);
  }

  set(topic: string, ring: TopicRing): this {
    // A topic already held keeps its place in the order; only a name never seen has to find one.
    if (!this.runs.has(topic)) this.waiting.push(topic);
    this.runs.set(topic, ring);

    return this;
  }

  delete(topic: string): boolean {
    if (!this.runs.delete(topic)) return false;

    this.gone++;

    return true;
  }

  clear(): void {
    this.runs.clear();
    this.sorted = [];
    this.waiting = [];
    this.gone = 0;
  }

  /**
   * The runs a `path/#` filter covers: the path's own, and every one beneath it.
   *
   * Two searches rather than one range, because a topic is not the prefix of its own children in
   * the order: `plant/a` sorts before `plant/b`, but so does `plant.spare`, which is under
   * nothing. Everything beginning `plant/` is contiguous; `plant` itself is asked for directly.
   */
  covering(path: string): TopicRing[] {
    this.settle();

    const found: TopicRing[] = [];

    const own = this.runs.get(path);
    if (own) found.push(own);

    const beneath = `${path}/`;
    for (let i = lowerBound(this.sorted, beneath); i < this.sorted.length; i++) {
      const topic = this.sorted[i];
      if (!topic.startsWith(beneath)) break;

      const ring = this.runs.get(topic);
      if (ring) found.push(ring);
    }

    return found;
  }

  /** Every run there is, in the same order a branch's are given in. */
  all(): TopicRing[] {
    this.settle();

    const found: TopicRing[] = [];
    for (const topic of this.sorted) {
      const ring = this.runs.get(topic);
      if (ring) found.push(ring);
    }

    return found;
  }

  forEach(run: (ring: TopicRing, topic: string, map: ReadonlyMap<string, TopicRing>) => void): void {
    this.runs.forEach((ring, topic) => run(ring, topic, this));
  }

  keys(): MapIterator<string> {
    return this.runs.keys();
  }

  values(): MapIterator<TopicRing> {
    return this.runs.values();
  }

  entries(): MapIterator<[string, TopicRing]> {
    return this.runs.entries();
  }

  [Symbol.iterator](): MapIterator<[string, TopicRing]> {
    return this.runs.entries();
  }

  get [Symbol.toStringTag](): string {
    return 'Map';
  }

  /**
   * Brings the order up to date, and the only place either list is written.
   *
   * Topics that have gone are dropped here too, in the same pass, rather than where they were
   * evicted: eviction takes thousands of topics at once, and taking each one out of the order on
   * its own would be the length of the order paid thousands of times — the very cost the waiting
   * list exists to avoid on the way in.
   *
   * The merged run is read for repeats as it is built. A topic evicted and then heard from again
   * is in `sorted` and in `waiting` at once, and a run counted twice would put a topic's messages
   * on screen twice.
   */
  private settle(): void {
    if (this.waiting.length === 0 && this.gone === 0) return;

    this.waiting.sort();

    const merged: string[] = [];
    const keep = (topic: string) => {
      if (merged.length > 0 && merged[merged.length - 1] === topic) return;
      if (this.gone > 0 && !this.runs.has(topic)) return;

      merged.push(topic);
    };

    let i = 0;
    let j = 0;
    while (i < this.sorted.length && j < this.waiting.length) {
      keep(this.sorted[i] <= this.waiting[j] ? this.sorted[i++] : this.waiting[j++]);
    }
    while (i < this.sorted.length) keep(this.sorted[i++]);
    while (j < this.waiting.length) keep(this.waiting[j++]);

    this.sorted = merged;
    this.waiting = [];
    this.gone = 0;
  }
}

/** Where `key` belongs in a sorted list: the first place not before it. */
function lowerBound(sorted: readonly string[], key: string): number {
  let low = 0;
  let high = sorted.length;

  while (low < high) {
    const mid = (low + high) >> 1;
    if (sorted[mid] < key) low = mid + 1;
    else high = mid;
  }

  return low;
}
