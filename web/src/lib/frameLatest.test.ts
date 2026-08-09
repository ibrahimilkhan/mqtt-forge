import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFrameLatest } from './frameLatest';

// Captures the scheduled callbacks so a test can decide when a frame happens.
function stubFrames() {
  const scheduled: Array<() => void> = [];
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => scheduled.push(callback));
  vi.stubGlobal('cancelAnimationFrame', () => {});
  return scheduled;
}

afterEach(() => vi.unstubAllGlobals());

describe('createFrameLatest', () => {
  it('applies only the last value offered within a frame', () => {
    const frames = stubFrames();
    const apply = vi.fn();
    const latest = createFrameLatest<number>(apply);

    latest.offer(1);
    latest.offer(2);
    latest.offer(3);
    expect(apply).not.toHaveBeenCalled();

    frames[0]();

    expect(apply).toHaveBeenCalledExactlyOnceWith(3);
  });

  // A pointer reports faster than the screen redraws; without this every report costs a layout.
  it('schedules one frame however many values arrive', () => {
    const frames = stubFrames();
    const latest = createFrameLatest<number>(vi.fn());

    for (let i = 0; i < 50; i++) latest.offer(i);

    expect(frames).toHaveLength(1);
  });

  it('takes a new value again once the frame has run', () => {
    const frames = stubFrames();
    const apply = vi.fn();
    const latest = createFrameLatest<number>(apply);

    latest.offer(1);
    frames[0]();
    latest.offer(2);
    frames[1]();

    expect(apply).toHaveBeenNthCalledWith(2, 2);
  });

  it('drops a value still waiting when it is cancelled', () => {
    const frames = stubFrames();
    const apply = vi.fn();
    const latest = createFrameLatest<number>(apply);

    latest.offer(1);
    latest.cancel();
    frames[0]();

    expect(apply).not.toHaveBeenCalled();
  });

  it('ignores anything offered after cancellation', () => {
    const frames = stubFrames();
    const apply = vi.fn();
    const latest = createFrameLatest<number>(apply);

    latest.cancel();
    latest.offer(1);

    expect(frames).toHaveLength(0);
    expect(apply).not.toHaveBeenCalled();
  });
});
