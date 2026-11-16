import { beforeEach, describe, expect, it } from 'vitest';
import type { StoreApi } from 'zustand';
import { blankScene } from './model/defaults';
import { createStudioStore, isDirty, type StudioState } from './studioStore';

let store: StoreApi<StudioState>;
const s = () => store.getState();

beforeEach(() => {
  store = createStudioStore();
  s().open(blankScene('Cell'));
});

describe('studio store', () => {
  it('adds a primitive standing on the ground, named, coloured and selected', () => {
    const id = s().addPrimitive('box', [1, 0, 2]);
    const box = s().scene!.objects[0];
    expect(box).toMatchObject({ id, type: 'box', name: 'Box 1', position: [1, 0.5, 2] });
    expect(box.color).toMatch(/^#/);
    expect(s().selection).toEqual([id]);
  });

  it('numbers names per kind so a second box is not called the same', () => {
    s().addPrimitive('box', [0, 0, 0]);
    s().addPrimitive('box', [0, 0, 0]);
    expect(s().scene!.objects.map((o) => o.name)).toEqual(['Box 1', 'Box 2']);
  });

  it('makes each discrete change one undo step, and redo puts it back', () => {
    const id = s().addPrimitive('box', [0, 0, 0]);
    s().updateObject(id, { color: '#000000' });
    s().undo();
    expect(s().scene!.objects[0].color).not.toBe('#000000');
    s().undo();
    expect(s().scene!.objects).toHaveLength(0);
    s().redo();
    s().redo();
    expect(s().scene!.objects[0].color).toBe('#000000');
  });

  // A gizmo drag sends a change on every pointer move; DesignBox turned whichever of those landed
  // after its 300 ms save debounce into undo steps. A gesture is one step, however many moves.
  it('makes a whole gesture one undo step', () => {
    const id = s().addPrimitive('box', [0, 0, 0]);
    s().beginGesture();
    for (let x = 1; x <= 20; x++) s().updateObject(id, { position: [x, 0.5, 0] });
    s().endGesture();
    expect(s().scene!.objects[0].position).toEqual([20, 0.5, 0]);
    s().undo();
    expect(s().scene!.objects[0].position).toEqual([0, 0.5, 0]);
  });

  it('records nothing for a gesture that changed nothing', () => {
    s().addPrimitive('box', [0, 0, 0]);
    const before = s().history.past.length;
    s().beginGesture();
    s().endGesture();
    expect(s().history.past).toHaveLength(before);
  });

  it('sets angles and the matching rotation together, wrapped', () => {
    const id = s().addPrimitive('box', [0, 0, 0]);
    s().setEuler(id, [0, 3 * Math.PI, 0]);
    const box = s().scene!.objects[0];
    expect(box.euler[1]).toBeCloseTo(Math.PI);
    expect(box.rotation[1]).toBeCloseTo(1);
  });

  it('duplicates beside the original and selects the copy', () => {
    const id = s().addPrimitive('box', [0, 0, 0]);
    const [copy] = s().duplicate([id]);
    expect(copy).not.toBe(id);
    expect(s().scene!.objects[1]).toMatchObject({ name: 'Box 1 copy', position: [0.5, 0.5, 0.5] });
    expect(s().selection).toEqual([copy]);
  });

  it('pastes what was copied as new objects', () => {
    const id = s().addPrimitive('sphere', [0, 0, 0]);
    s().copy([id]);
    const pasted = s().paste();
    expect(pasted).toHaveLength(1);
    expect(s().scene!.objects).toHaveLength(2);
  });

  it('removes objects and drops them from the selection', () => {
    const id = s().addPrimitive('box', [0, 0, 0]);
    s().removeObjects([id]);
    expect(s().scene!.objects).toHaveLength(0);
    expect(s().selection).toEqual([]);
  });

  it('is dirty after a change and clean once that revision is saved', () => {
    expect(isDirty(s())).toBe(false);
    s().addPrimitive('box', [0, 0, 0]);
    expect(isDirty(s())).toBe(true);
    s().markSaved(s().revision);
    expect(isDirty(s())).toBe(false);
  });

  it('opens an unsaved scene as dirty, so a new one is written straight away', () => {
    s().open(blankScene('New'), false);
    expect(isDirty(s())).toBe(true);
  });

  it('starts every opened scene with no history and no selection', () => {
    s().addPrimitive('box', [0, 0, 0]);
    s().open(blankScene('Other'));
    expect(s().history.past).toEqual([]);
    expect(s().selection).toEqual([]);
  });

  it('prevents undo during a gesture and undoes to pre-gesture state after endGesture', () => {
    const id = s().addPrimitive('box', [0, 0, 0]);
    s().beginGesture();
    s().updateObject(id, { position: [5, 0.5, 0] });
    const beforeUndo = s().history.past.length;
    s().undo();
    // undo should do nothing while gesture is open
    expect(s().scene!.objects[0].position).toEqual([5, 0.5, 0]);
    expect(s().history.past.length).toBe(beforeUndo);
    // after ending the gesture, undo should work
    s().endGesture();
    s().undo();
    expect(s().scene!.objects[0].position).toEqual([0, 0.5, 0]);
  });
});
