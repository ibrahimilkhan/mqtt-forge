import { describe, expect, it } from 'vitest';
import { moved, openingBox, sized } from './floating';

// jsdom's own window, which is what the module measures against.
const SCREEN = { w: window.innerWidth, h: window.innerHeight };

const box = { x: 300, y: 200, w: 400, h: 300 };

describe('placing a chart window', () => {
  it('opens at three fifths of the window, in the middle of it', () => {
    const opened = openingBox();

    expect(opened.w).toBe(Math.round(SCREEN.w * 0.6));
    // Within a pixel: a box of whole pixels cannot be centred exactly in an odd one.
    expect(Math.abs(opened.x + opened.w / 2 - SCREEN.w / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(opened.y + opened.h / 2 - SCREEN.h / 2)).toBeLessThanOrEqual(1);
  });

  it('moves by what the pointer moved', () => {
    expect(moved(box, 40, -30)).toMatchObject({ x: 340, y: 170 });
  });

  // Two windows in adjacent corners should have edges that meet rather than nearly meet.
  it('takes a corner exactly when it is brought near one', () => {
    const carried = moved(box, -300 + 7, -200 + 5);

    expect(carried).toMatchObject({ x: 0, y: 0 });
  });

  it('takes the far corner the same way', () => {
    const carried = moved(box, SCREEN.w - box.w - box.x - 6, SCREEN.h - box.h - box.y + 4);

    expect(carried).toMatchObject({ x: SCREEN.w - box.w, y: SCREEN.h - box.h });
  });

  // Narrow on purpose: a window that pulls itself from fifty pixels away has taken the placing
  // off the reader, who cannot then have it forty pixels off the corner.
  it('leaves a window where it was put once it is clear of the edge', () => {
    const carried = moved(box, -300 + 24, -200 + 24);

    expect(carried).toMatchObject({ x: 24, y: 24 });
  });

  it('never lets a window off the screen entirely', () => {
    expect(moved(box, 4000, 4000).x).toBeLessThanOrEqual(SCREEN.w - 64);
    expect(moved(box, 4000, 4000).y).toBeLessThanOrEqual(SCREEN.h - 64);
    // Off the left, there must still be a bar to take hold of.
    expect(moved(box, -4000, 0).x + box.w).toBeGreaterThanOrEqual(64);
  });
});

describe('sizing a chart window', () => {
  it('grows by what the pointer moved', () => {
    expect(sized(box, 60, 40)).toMatchObject({ w: 460, h: 340 });
  });

  // The floor is the chart's own arithmetic: the region a chart needs before it draws its
  // readings, plus the bar and the padding a window spends before that region begins.
  it('keeps a chart above the size it stops being readable at', () => {
    expect(sized(box, -4000, -4000)).toMatchObject({ w: 300, h: 282 });
  });

  it('fills a corner exactly when its far edge is brought near one', () => {
    const grown = sized(box, SCREEN.w - box.x - box.w - 5, SCREEN.h - box.y - box.h - 5);

    expect(grown.w).toBe(SCREEN.w - box.x);
    expect(grown.h).toBe(SCREEN.h - box.y);
  });
});
