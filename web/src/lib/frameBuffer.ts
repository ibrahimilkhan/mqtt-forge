// Collects items and hands them over once per animation frame. A busy broker can deliver
// hundreds of messages per second; flushing per frame caps re-renders at the refresh rate.
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

    // Called when the bridge unmounts; a frame already scheduled must not fire into a
    // torn-down tree.
    cancel() {
      cancelled = true;
      if (frame) cancelAnimationFrame(frame);
      buffer = [];
      frame = 0;
    },
  };
}
