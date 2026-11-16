import { describe, expect, it } from 'vitest';
import { blankScene } from './model/defaults';
import { HISTORY_LIMIT, record, redo, undo } from './history';

describe('history', () => {
  it('steps back to what was recorded and forward again', () => {
    const a = blankScene('A');
    const b = { ...a, name: 'B' };
    const h = record({ past: [], future: [] }, a);

    const back = undo(h, b)!;
    expect(back.scene).toBe(a);
    const forward = redo(back.history, back.scene)!;
    expect(forward.scene).toBe(b);
  });

  it('has nothing to undo or redo when empty', () => {
    expect(undo({ past: [], future: [] }, blankScene('A'))).toBeNull();
    expect(redo({ past: [], future: [] }, blankScene('A'))).toBeNull();
  });

  it('forgets the redo trail once something new is recorded', () => {
    const a = blankScene('A');
    const back = undo(record({ past: [], future: [] }, a), { ...a, name: 'B' })!;
    expect(record(back.history, a).future).toEqual([]);
  });

  it('keeps no more than its limit', () => {
    let h = { past: [], future: [] } as ReturnType<typeof record>;
    for (let i = 0; i < HISTORY_LIMIT + 10; i++) h = record(h, blankScene(String(i)));
    expect(h.past).toHaveLength(HISTORY_LIMIT);
    expect(h.past[0].name).toBe('10');
  });
});
