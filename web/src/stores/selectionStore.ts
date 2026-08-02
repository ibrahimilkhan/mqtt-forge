import { create } from 'zustand';

// filter is the identity; label differs only for tree nodes ('sensors/room' vs 'sensors/room/#').
type Selection = { label: string; filter: string };

type SelectionState = {
  selected: Selection | null;
  select: (selection: Selection) => void;
  clear: () => void;
};

export const useSelectionStore = create<SelectionState>((set) => ({
  selected: null,

  // Re-picking the same selection clears it (toggle).
  select: (selection) =>
    set((state) => ({ selected: state.selected?.filter === selection.filter ? null : selection })),

  clear: () => set({ selected: null }),
}));
