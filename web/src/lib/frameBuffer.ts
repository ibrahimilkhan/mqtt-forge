// Batches items and flushes once per animation frame, capping re-render rate.
export function createFrameBuffer<T>(flush: (batch: T[]) => void) {
  let buffer: T[] = [];
  let frame = 0;
  let cancelled = false;

  return {
    push(item: T) {
      if (cancelled) return;
      buffer.push(item);
      if (frame) return;

      frame = requestAnimationFrame(() => {
        const batch = buffer;
        buffer = [];
        frame = 0;
        if (!cancelled) flush(batch);
      });
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
