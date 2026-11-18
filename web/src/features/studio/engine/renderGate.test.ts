import { describe, expect, it } from 'vitest';
import { createRenderGate } from './renderGate';

const frames = (gate: ReturnType<typeof createRenderGate>, count: number, settling = false) =>
  Array.from({ length: count }, () => gate.due(settling));

describe('createRenderGate', () => {
  it('draws the opening frames, then stops while nothing changes', () => {
    const gate = createRenderGate();

    expect(frames(gate, 5)).toEqual([true, true, false, false, false]);
  });

  it('draws again when woken, for long enough to settle', () => {
    const gate = createRenderGate();
    frames(gate, 5);

    gate.wake();

    expect(frames(gate, 4)).toEqual([true, true, false, false]);
  });

  it('does not stack wakes into more frames', () => {
    const gate = createRenderGate();
    frames(gate, 5);

    gate.wake();
    gate.wake();
    gate.wake();

    expect(frames(gate, 4)).toEqual([true, true, false, false]);
  });

  it('goes on drawing while the scene is still settling, woken or not', () => {
    const gate = createRenderGate();
    frames(gate, 5);

    expect(frames(gate, 3, true)).toEqual([true, true, true]);
    expect(frames(gate, 1)).toEqual([false]);
  });
});
