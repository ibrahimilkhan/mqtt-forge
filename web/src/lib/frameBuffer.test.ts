import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFrameBuffer } from './frameBuffer';

// Captures the scheduled callbacks so a test can decide when a frame happens.
function stubFrames() {
  const scheduled: Array<() => void> = [];
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => scheduled.push(callback));
  vi.stubGlobal('cancelAnimationFrame', () => {});
  return scheduled;
}

afterEach(() => vi.unstubAllGlobals());

describe('createFrameBuffer', () => {
  it('hands everything pushed within one frame over as a single batch', () => {
    const frames = stubFrames();
    const flush = vi.fn();
    const buffer = createFrameBuffer<number>(flush);

    buffer.push(1);
    buffer.push(2);
    buffer.push(3);
    expect(flush).not.toHaveBeenCalled();

    frames[0]();

    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith([1, 2, 3]);
  });

  it('schedules exactly one frame per burst', () => {
    const frames = stubFrames();
    const buffer = createFrameBuffer<number>(vi.fn());

    buffer.push(1);
    buffer.push(2);

    expect(frames).toHaveLength(1);
  });

  it('starts a new batch after a flush', () => {
    const frames = stubFrames();
    const flush = vi.fn();
    const buffer = createFrameBuffer<number>(flush);

    buffer.push(1);
    frames[0]();
    buffer.push(2);
    frames[1]();

    expect(flush).toHaveBeenNthCalledWith(2, [2]);
  });

  it('drops what it holds when cancelled', () => {
    const frames = stubFrames();
    const flush = vi.fn();
    const buffer = createFrameBuffer<number>(flush);

    buffer.push(1);
    buffer.cancel();
    frames[0]();

    expect(flush).not.toHaveBeenCalled();
  });
});
