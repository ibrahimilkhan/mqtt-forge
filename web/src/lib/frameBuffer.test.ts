import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFrameBuffer } from './frameBuffer';

// Captures the scheduled callbacks so a test can decide when a frame happens.
function stubFrames() {
  const scheduled: Array<() => void> = [];
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => scheduled.push(callback));
  vi.stubGlobal('cancelAnimationFrame', () => {});
  return scheduled;
}

/**
 * Runs frames until nothing more is scheduled, since a frame that leaves work over books the
 * next one itself. Bounded, so a queue that never empties fails the test rather than the run.
 */
function runFrames(scheduled: Array<() => void>, limit = 1000) {
  for (let ran = 0; scheduled.length > 0; ran++) {
    if (ran > limit) throw new Error('the queue never emptied');
    scheduled.shift()!();
  }
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

  it('takes a whole batch at once, since the server already groups them', () => {
    const frames = stubFrames();
    const flush = vi.fn();
    const buffer = createFrameBuffer<number>(flush);

    buffer.pushAll([1, 2]);
    buffer.pushAll([3]);
    frames[0]();

    expect(flush).toHaveBeenCalledExactlyOnceWith([1, 2, 3]);
  });

  it('schedules no frame for an empty batch', () => {
    const frames = stubFrames();
    const buffer = createFrameBuffer<number>(vi.fn());

    buffer.pushAll([]);

    expect(frames).toHaveLength(0);
  });

  it('drops a batch handed over after cancellation', () => {
    const frames = stubFrames();
    const flush = vi.fn();
    const buffer = createFrameBuffer<number>(flush);

    buffer.cancel();
    buffer.pushAll([1]);

    expect(frames).toHaveLength(0);
    expect(flush).not.toHaveBeenCalled();
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

// Stopping the console holds the queue rather than emptying it: what went past while the reader
// was looking is what they stopped it to look at. The bound and the drain rate are what make
// that affordable, and they are what these check.
describe('holding the queue', () => {
  it('hands nothing over while it is held', () => {
    const frames = stubFrames();
    const flush = vi.fn();
    const buffer = createFrameBuffer<number>(flush);

    buffer.hold();
    buffer.pushAll([1, 2, 3]);
    runFrames(frames);

    expect(flush).not.toHaveBeenCalled();
    expect(buffer.waiting()).toBe(3);
  });

  it('keeps what was already waiting when it is held mid-flight', () => {
    const frames = stubFrames();
    const flush = vi.fn();
    const buffer = createFrameBuffer<number>(flush);

    buffer.pushAll([1, 2]);
    buffer.hold();
    runFrames(frames);

    expect(flush).not.toHaveBeenCalled();
    expect(buffer.waiting()).toBe(2);
  });

  it('hands over everything it held, oldest first, once it is let go', () => {
    const frames = stubFrames();
    const flush = vi.fn();
    const buffer = createFrameBuffer<number>(flush);

    buffer.hold();
    buffer.pushAll([1, 2]);
    buffer.pushAll([3]);
    buffer.release();
    runFrames(frames);

    expect(flush.mock.calls.flatMap(([batch]) => batch)).toEqual([1, 2, 3]);
    expect(buffer.waiting()).toBe(0);
  });

  it('takes a stop during the drain, and keeps what has not landed yet', () => {
    const frames = stubFrames();
    const flush = vi.fn();
    const buffer = createFrameBuffer<number>(flush, { perFrame: 2 });

    buffer.hold();
    buffer.pushAll([1, 2, 3, 4, 5]);
    buffer.release();
    frames.shift()!();
    buffer.hold();
    runFrames(frames);

    expect(flush.mock.calls.flatMap(([batch]) => batch)).toEqual([1, 2]);
    expect(buffer.waiting()).toBe(3);
  });
});

// A queue handed over in one frame is the avalanche that stopping used to be designed around.
describe('the rate it hands them over at', () => {
  it('hands over no more than one frame worth at a time', () => {
    const frames = stubFrames();
    const flush = vi.fn();
    const buffer = createFrameBuffer<number>(flush, { perFrame: 2 });

    buffer.pushAll([1, 2, 3, 4, 5]);
    runFrames(frames);

    expect(flush.mock.calls.map(([batch]) => batch)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('books the next frame itself while anything is left', () => {
    const frames = stubFrames();
    const buffer = createFrameBuffer<number>(vi.fn(), { perFrame: 1 });

    buffer.pushAll([1, 2]);
    expect(frames).toHaveLength(1);

    frames.shift()!();

    expect(frames).toHaveLength(1);
  });

  it('takes what arrives during a drain in its turn, behind what was already waiting', () => {
    const frames = stubFrames();
    const flush = vi.fn();
    const buffer = createFrameBuffer<number>(flush, { perFrame: 2 });

    buffer.pushAll([1, 2, 3]);
    frames.shift()!();
    buffer.push(4);
    runFrames(frames);

    expect(flush.mock.calls.flatMap(([batch]) => batch)).toEqual([1, 2, 3, 4]);
  });
});

// The one place a message can be lost, and it says so out loud rather than quietly.
describe('the ceiling', () => {
  it('drops the oldest when more are waiting than it may hold', () => {
    const frames = stubFrames();
    const flush = vi.fn();
    const buffer = createFrameBuffer<number>(flush, { ceiling: 3 });

    buffer.hold();
    buffer.pushAll([1, 2, 3, 4, 5]);
    buffer.release();
    runFrames(frames);

    expect(flush.mock.calls.flatMap(([batch]) => batch)).toEqual([3, 4, 5]);
  });

  it('says how many it dropped', () => {
    stubFrames();
    const lost = vi.fn();
    const buffer = createFrameBuffer<number>(vi.fn(), { ceiling: 2, onOverflow: lost });

    buffer.hold();
    buffer.pushAll([1, 2, 3, 4]);

    expect(lost).toHaveBeenCalledExactlyOnceWith(2);
  });

  it('says nothing while the queue is inside it', () => {
    stubFrames();
    const lost = vi.fn();
    const buffer = createFrameBuffer<number>(vi.fn(), { ceiling: 10, onOverflow: lost });

    buffer.hold();
    buffer.pushAll([1, 2, 3]);

    expect(lost).not.toHaveBeenCalled();
    expect(buffer.waiting()).toBe(3);
  });

  // The read head is left behind the array's start until the dead half is worth a copy, so this
  // is what proves the copy happens and the queue does not grow for ever behind it.
  it('holds no more than its ceiling however long the flow lasts', () => {
    stubFrames();
    const buffer = createFrameBuffer<number>(vi.fn(), { ceiling: 100 });

    buffer.hold();
    for (let n = 0; n < 20_000; n++) buffer.push(n);

    expect(buffer.waiting()).toBe(100);
  });
});
