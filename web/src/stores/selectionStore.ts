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

  // Picking is not a switch: clicking the topic you are already reading leaves it on screen.
  // Putting the log away is the wire log's own × — an explicit act, not a mis-aimed second click.
  // Re-picking the very same thing is dropped rather than re-set, so the pane does not re-render
  // on a click that changed nothing. A new label for the same filter is a change, and lands.
  select: (selection) =>
    set((state) =>
      state.selected?.filter === selection.filter && state.selected.label === selection.label
        ? state
        : { selected: selection },
    ),

  clear: () => set({ selected: null }),
}));
