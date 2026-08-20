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

/** Below this a chart is a smudge with chips over it, whatever the reader drags. The height is
 *  what the plot's own floor, the controls over it and a line or two of the note come to. */
const MIN_W = 300;
const MIN_H = 260;

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

/** Three fifths of the window, centred — the size and place the chart has always opened at. */
export function openingBox(): Box {
  const w = Math.round(window.innerWidth * 0.6);
  const h = Math.round(window.innerHeight * 0.6);

  return { x: Math.round((window.innerWidth - w) / 2), y: Math.round((window.innerHeight - h) / 2), w, h };
}

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
  const grabbed = useRef<{ x: number; y: number; from: Box } | null>(null);

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
    const on = event.target as Element;
    if (on !== event.currentTarget && on.closest('button')) return;

    // Without this the drag selects the text it sweeps across.
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    grabbed.current = { x: event.clientX, y: event.clientY, from: box };
  };

  const drag = (apply: (from: Box, dx: number, dy: number) => Box) => (event: ReactPointer<HTMLElement>) => {
    const held = grabbed.current;
    if (!held) return;

    frame.offer(apply(held.from, event.clientX - held.x, event.clientY - held.y));
  };

  // Only what this took is given back: a pointer that came up here without having gone down here
  // — the tail of a click on a control in the bar — was never captured, and asking to release it
  // is asking about a pointer nothing is holding.
  const drop = (event: ReactPointer<HTMLElement>) => {
    if (!grabbed.current) return;

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
    bar: { onPointerDown: take, onPointerMove: drag(moved), onPointerUp: drop, onPointerCancel: drop },
    grip: {
      onPointerDown: take,
      onPointerMove: drag(sized),
      onPointerUp: drop,
      onPointerCancel: drop,
      onKeyDown: keys(sized),
    },
  };
}
