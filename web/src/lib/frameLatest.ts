// Holds the newest value and applies it once per animation frame. Sibling to createFrameBuffer:
// that one keeps every item, this one keeps only the last, which is what a drag wants — the
// intermediate pointer positions are already stale by the time the screen redraws.
export function createFrameLatest<T>(apply: (value: T) => void) {
  let pending: { value: T } | null = null;
  let frame = 0;
  let cancelled = false;

  return {
    offer(value: T) {
      if (cancelled) return;
      pending = { value };
      if (frame) return;

      frame = requestAnimationFrame(() => {
        frame = 0;
        const held = pending;
        pending = null;
        if (held && !cancelled) apply(held.value);
      });
    },

    // Stops a frame scheduled before unmount from applying afterwards.
    cancel() {
      cancelled = true;
      if (frame) cancelAnimationFrame(frame);
      pending = null;
      frame = 0;
    },
  };
}
