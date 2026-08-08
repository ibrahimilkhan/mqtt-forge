// Batches items and flushes once per animation frame, capping re-render rate.
export function createFrameBuffer<T>(flush: (batch: T[]) => void) {
  let buffer: T[] = [];
  let frame = 0;
  let cancelled = false;

  function schedule() {
    if (frame) return;

    frame = requestAnimationFrame(() => {
      const batch = buffer;
      buffer = [];
      frame = 0;
      if (!cancelled) flush(batch);
    });
  }

  return {
    push(item: T) {
      if (cancelled) return;
      buffer.push(item);
      schedule();
    },

    // The hub already groups messages, so they arrive a batch at a time rather than one by one.
    pushAll(items: readonly T[]) {
      if (cancelled || items.length === 0) return;
      // Appended one at a time; spreading a large batch into push() risks the argument limit.
      for (const item of items) buffer.push(item);
      schedule();
    },

    // Prevents an already-scheduled frame from firing after unmount.
    cancel() {
      cancelled = true;
      if (frame) cancelAnimationFrame(frame);
      buffer = [];
      frame = 0;
    },
  };
}
