import { beforeEach, describe, expect, it } from 'vitest';
import { useSelectionStore } from './selectionStore';

const chip = { label: 'sensors/#', filter: 'sensors/#' };
const node = { label: 'sensors/room', filter: 'sensors/room/#' };

beforeEach(() => useSelectionStore.getState().clear());

describe('selectionStore', () => {
  it('starts with nothing selected', () => {
    expect(useSelectionStore.getState().selected).toBeNull();
  });

  it('holds what was selected', () => {
    useSelectionStore.getState().select(chip);

    expect(useSelectionStore.getState().selected).toEqual(chip);
  });

  it('clears the selection when the same filter is picked again', () => {
    useSelectionStore.getState().select(chip);
    useSelectionStore.getState().select(chip);

    expect(useSelectionStore.getState().selected).toBeNull();
  });

  it('replaces the selection when a different filter is picked', () => {
    useSelectionStore.getState().select(chip);
    useSelectionStore.getState().select(node);

    expect(useSelectionStore.getState().selected).toEqual(node);
  });

  it('clears on demand', () => {
    useSelectionStore.getState().select(node);
    useSelectionStore.getState().clear();

    expect(useSelectionStore.getState().selected).toBeNull();
  });
});
