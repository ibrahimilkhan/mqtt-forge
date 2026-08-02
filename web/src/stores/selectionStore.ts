import { create } from 'zustand';

// What the wire log is focused on. The filter is the identity: the label only differs from it
// for tree nodes, where 'sensors/room' is shown but 'sensors/room/#' is matched against.
type Selection = { label: string; filter: string };

type SelectionState = {
  selected: Selection | null;
  select: (selection: Selection) => void;
  clear: () => void;
};

export const useSelectionStore = create<SelectionState>((set) => ({
  selected: null,

  // Picking what is already picked clears it, so one click both selects and deselects.
  select: (selection) =>
    set((state) => ({ selected: state.selected?.filter === selection.filter ? null : selection })),

  clear: () => set({ selected: null }),
}));
