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

    /**
     * Back in service, after a cancellation that turned out not to be an unmount.
     *
     * React mounts an effect, tears it down and mounts it again in development, so a component
     * that cancels this from its cleanup cancels it for good — on the second mount every value it
     * offered was dropped on the floor and nothing ever applied. The drag this was written for had
     * been dead in development the whole time, which is the one place it is ever debugged.
     *
     * A line, and the pair reads symmetrically: whoever stops it on the way out starts it again on
     * the way in.
     */
    resume() {
      cancelled = false;
    },
  };
}
