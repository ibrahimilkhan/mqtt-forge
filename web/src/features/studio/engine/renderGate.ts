/**
 * How many frames are drawn after the last thing that could have changed the picture.
 *
 * Two rather than one: a pointer or a store change lands between frames, and some of what it
 * causes — the camera taking up its inertia, a gizmo answering a hover — only happens inside the
 * next render, whose own change then wakes the gate again if there is more to come.
 */
const SETTLE_FRAMES = 2;

/**
 * Whether the studio draws this frame.
 *
 * A still scene used to be drawn sixty times a second, shadows and all, on the thread that also
 * takes in the broker's traffic. Drawn only when something has moved, an idle studio costs a
 * frame nothing and leaves the whole of it to the stream.
 */
export function createRenderGate() {
  // Owed from the start, so the first picture is drawn without anything having to ask for it.
  let owed = SETTLE_FRAMES;

  return {
    /** Something may have changed what is on screen. */
    wake() {
      owed = SETTLE_FRAMES;
    },

    /**
     * Asked once a frame. `settling` is the scene still compiling or loading, which changes the
     * picture without telling anyone, so it is drawn until it is done.
     */
    due(settling: boolean) {
      if (owed > 0) {
        owed -= 1;
        return true;
      }
      return settling;
    },
  };
}
