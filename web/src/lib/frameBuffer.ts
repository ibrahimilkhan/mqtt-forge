/** How many are handed over in one frame when no other ceiling is given: all of them. */
const ALL = Infinity;

/**
 * How far the read head may run ahead of the array's start before the head is thrown away.
 *
 * Taking from the front by index rather than by `splice` keeps a flush at the cost of the batch
 * rather than the cost of the queue — but the items behind the head are still held, so the array
 * is rebuilt once the dead half is worth the copy. Four thousand is small enough to be free and
 * large enough that the copy is rare.
 */
const COMPACT_AT = 4_096;

type Options = {
  /**
   * How many items one frame may hand over. What is left waits for the next frame, so a queue
   * that built up while nothing was draining it comes in at a steady rate rather than in one
   * frame that locks the window.
   */
  perFrame?: number;
  /** How many may wait at once. Past it the oldest go, which is what a ring would do to them. */
  ceiling?: number;
  /** Told how many the ceiling forced out, since that is the one place items are lost. */
  onOverflow?: (lost: number) => void;
};

/**
 * Batches items and hands them over a frame at a time, capping the re-render rate.
 *
 * Holdable, because the console can be told to stop taking messages: held, the queue goes on
 * filling and nothing is handed over, and letting go drains it at the frame rate rather than
 * all at once. Bounded, because a queue nobody is draining has no bound otherwise — but the
 * bound is the console's own capacity, so what falls off the end is what the log's ring would
 * have dropped anyway.
 */
export function createFrameBuffer<T>(flush: (batch: T[]) => void, options: Options = {}) {
  const perFrame = options.perFrame ?? ALL;
  const ceiling = options.ceiling ?? ALL;

  let buffer: T[] = [];
  // Where the next batch starts. Everything before it has been handed over already.
  let at = 0;
  let frame = 0;
  let held = false;
  let cancelled = false;

  const waiting = () => buffer.length - at;

  function compact() {
    if (at < COMPACT_AT) return;

    buffer = buffer.slice(at);
    at = 0;
  }

  function trim() {
    const over = waiting() - ceiling;
    if (over <= 0) return;

    at += over;
    compact();
    options.onOverflow?.(over);
  }

  function schedule() {
    if (frame || held || cancelled || waiting() === 0) return;

    frame = requestAnimationFrame(() => {
      frame = 0;
      if (cancelled || held) return;

      const batch = buffer.slice(at, at + perFrame);
      at += batch.length;
      if (at === buffer.length) {
        buffer = [];
        at = 0;
      } else {
        compact();
      }

      flush(batch);
      // Whatever is left goes next frame, and so does whatever arrived during this one.
      schedule();
    });
  }

  return {
    push(item: T) {
      if (cancelled) return;

      buffer.push(item);
      trim();
      schedule();
    },

    // The hub already groups messages, so they arrive a batch at a time rather than one by one.
    pushAll(items: readonly T[]) {
      if (cancelled || items.length === 0) return;
      // Appended one at a time; spreading a large batch into push() risks the argument limit.
      for (const item of items) buffer.push(item);
      trim();
      schedule();
    },

    /**
     * Stops handing anything over. What arrives meanwhile queues rather than being thrown away:
     * a reader who stops the console is asking it to hold still, not to stop listening, and the
     * messages that go past while it is held are the ones they stopped it to look at.
     */
    hold() {
      held = true;
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
    },

    /** Starts handing over again, oldest first, at `perFrame` a frame. */
    release() {
      held = false;
      schedule();
    },

    /**
     * Lets go of everything waiting, and says how much that was.
     *
     * For what has stopped being about anything: a queue held for a tree that has since started
     * again is a queue of messages from a session that is no longer on screen, and handing them
     * over would write yesterday's values over today's.
     */
    forget(): number {
      const dropped = waiting();

      buffer = [];
      at = 0;
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }

      return dropped;
    },

    /** How many are waiting to be handed over. */
    waiting,

    // Prevents an already-scheduled frame from firing after unmount.
    cancel() {
      cancelled = true;
      if (frame) cancelAnimationFrame(frame);
      buffer = [];
      at = 0;
      frame = 0;
    },
  };
}
