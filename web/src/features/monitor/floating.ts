import { useEffect, useMemo, useRef, type PointerEvent as ReactPointer } from 'react';
import { createFrameLatest } from '../../lib/frameLatest';

/**
 * Where a floating chart window stands, and how it is moved and sized.
 *
 * Pixels against the viewport rather than shares of it: a window a reader placed beside another
 * one is placed *there*, and a share that reflowed on every resize would not be. The clamps below
 * are what keep that honest when the window it was placed against gets smaller.
 */
export type Box = { x: number; y: number; w: number; h: number };

/**
 * Below this a chart is a smudge with chips over it, whatever the reader drags.
 *
 * The height is what the plot's own floor, the controls over it and the note come to, and it is
 * now that arithmetic rather than a number near it: ROOM_FOR_MORE (220) is what the chart asks of
 * its own region before it will draw the readings, and a window spends 62px on its bar and its
 * padding before the region begins. At 260 the comment above claimed a line or two of the note
 * and the window delivered none — the chart measured 198px of region and drew the picture alone.
 * Set from the two, so a window that can exist is a window with its readings in it.
 */
const MIN_W = 300;
const MIN_H = 282;

/** How much of a window must stay on screen: enough to get hold of the bar again. */
const HELD = 64;

/**
 * How near an edge a window has to be brought before it takes that edge exactly.
 *
 * Narrow on purpose. A window that pulls itself straight from ten pixels away is helping; one
 * that pulls itself from fifty has taken the placing off the reader, and a reader who wanted it
 * forty pixels off the corner cannot have it. Twelve is about the distance a hand comes to rest
 * within when it is aiming at a corner and not thinking about it.
 */
const SNAP = 12;

/**
 * Three fifths of the window, centred — the size and place the chart has always opened at.
 *
 * Never under the floor a drag would stop at: on a phone three fifths is about 225 across, which
 * is a window that opens smaller than it can be sized back to, and a chart nobody can read.
 */
export function openingBox(): Box {
  const w = Math.max(Math.round(window.innerWidth * 0.6), MIN_W);
  const h = Math.max(Math.round(window.innerHeight * 0.6), MIN_H);

  return {
    x: Math.round((window.innerWidth - w) / 2),
    y: Math.round((window.innerHeight - h) / 2),
    w,
    h,
  };
}

/**
 * Every pixel of the viewport.
 *
 * No inset, and no floor either. The floors above are about a window a reader is dragging — a
 * chart nobody can read is a chart nobody meant to make — and this is the opposite gesture: it is
 * asked for by name, it is one press to undo, and a viewport too small to hold the floor is still
 * a viewport this should fill rather than hang off.
 */
export const fullBox = (): Box => ({ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight });

/** Dragged by the bar. The window keeps its size; only the corner it starts at moves. */
export function moved(box: Box, dx: number, dy: number): Box {
  return onScreen(docked({ ...box, x: box.x + dx, y: box.y + dy }));
}

/** Dragged by the grip. The top-left corner is the anchor, so only the far edges move. */
export function sized(box: Box, dx: number, dy: number): Box {
  const w = clamp(box.w + dx, MIN_W, window.innerWidth - box.x);
  const h = clamp(box.h + dy, MIN_H, window.innerHeight - box.y);

  // The far edges settle onto the viewport's the same way the near ones do when it is dragged,
  // so a window sized into a corner fills it exactly rather than to within a few pixels.
  return {
    ...box,
    w: near(box.x + w, window.innerWidth) ? window.innerWidth - box.x : w,
    h: near(box.y + h, window.innerHeight) ? window.innerHeight - box.y : h,
  };
}

/**
 * A window brought near an edge takes it exactly.
 *
 * Each axis on its own, which is what makes the corners work without being a case: a window
 * carried into the top-left is near two edges at once, and taking both is what putting something
 * in a corner means. Two of these side by side then have edges that meet rather than nearly
 * meet — which is the whole reason to want it, with several charts on screen.
 */
function docked(box: Box): Box {
  const right = window.innerWidth - box.w;
  const bottom = window.innerHeight - box.h;

  return {
    ...box,
    x: near(box.x, 0) ? 0 : near(box.x, right) ? right : box.x,
    y: near(box.y, 0) ? 0 : near(box.y, bottom) ? bottom : box.y,
  };
}

const near = (value: number, edge: number) => Math.abs(value - edge) <= SNAP;

/** A window may hang off any edge, but never so far that there is no bar left to take hold of. */
function onScreen(box: Box): Box {
  return {
    ...box,
    x: clamp(box.x, HELD - box.w, window.innerWidth - HELD),
    y: clamp(box.y, 0, window.innerHeight - HELD),
  };
}

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), Math.max(low, high));

/** How far an arrow key moves or grows a window — the same step the panel seams use, in pixels. */
const STEP = 16;

/**
 * The pointer and key handling for one floating window: one set for the bar that moves it, one
 * for the grip that sizes it.
 *
 * The box is read at the grab rather than followed through the drag, so what the pointer reports
 * is a distance from where it went down — which is the only reading that cannot drift as the
 * window moves out from under it.
 */
export function useFloating(box: Box, onChange: (next: Box) => void) {
  const grabbed = useRef<{ pointer: number; x: number; y: number; from: Box } | null>(null);

  // A pointer reports far more often than the screen redraws, and every report relays out a
  // chart. Only the newest position of each frame is worth anything. Same reasoning as the
  // workspace seams, and the same helper.
  const latest = useRef(onChange);
  latest.current = onChange;
  const frame = useMemo(() => createFrameLatest<Box>((next) => latest.current(next)), []);
  useEffect(() => frame.cancel, [frame]);

  const take = (event: ReactPointer<HTMLElement>) => {
    // The bar is the handle; the controls standing in it are not. Without this, pressing the pin
    // takes hold of the window, and the press reads as the start of a drag that never moves.
    // The handle itself is exempt — the grip is a button, and pressing it is the whole point.
    //
    // Which button the press is in, rather than whether the press is on the handle itself: the
    // grip carries a mark now, so the thing under the pointer there is an svg rather than the
    // button, and a test of the element alone threw the resize away the moment the corner grew
    // something to look at.
    const on = event.target as Element;
    const pressed = on.closest('button');
    if (pressed && pressed !== event.currentTarget) return;

    // One pointer at a time. A second finger landing on the bar would otherwise take the drag
    // over from where IT went down, and the window would jump by the distance between the two.
    if (grabbed.current) return;

    // Without this the drag selects the text it sweeps across.
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    grabbed.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, from: box };
  };

  const drag = (apply: (from: Box, dx: number, dy: number) => Box) => (event: ReactPointer<HTMLElement>) => {
    const held = grabbed.current;
    if (!held || held.pointer !== event.pointerId) return;

    frame.offer(apply(held.from, event.clientX - held.x, event.clientY - held.y));
  };

  // Only what this took is given back: a pointer that came up here without having gone down here
  // — the tail of a click on a control in the bar — was never captured, and asking to release it
  // is asking about a pointer nothing is holding.
  const drop = (event: ReactPointer<HTMLElement>) => {
    if (grabbed.current?.pointer !== event.pointerId) return;

    grabbed.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const keys = (apply: (from: Box, dx: number, dy: number) => Box) => (event: { key: string; preventDefault: () => void }) => {
    const step: Record<string, [number, number]> = {
      ArrowLeft: [-STEP, 0],
      ArrowRight: [STEP, 0],
      ArrowUp: [0, -STEP],
      ArrowDown: [0, STEP],
    };
    const nudge = step[event.key];
    if (!nudge) return;

    onChange(apply(box, nudge[0], nudge[1]));
    event.preventDefault();
  };

  return {
    bar: {
      onPointerDown: take,
      onPointerMove: drag(moved),
      onPointerUp: drop,
      onPointerCancel: drop,
      // The bar takes focus and the arrow keys move the window by it, for the same reason the
      // grip does: a window that can only be placed with a pointer is a window some readers
      // cannot place at all.
      onKeyDown: keys(moved),
    },
    grip: {
      onPointerDown: take,
      onPointerMove: drag(sized),
      onPointerUp: drop,
      onPointerCancel: drop,
      onKeyDown: keys(sized),
    },
  };
}
