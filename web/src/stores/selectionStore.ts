import { create } from 'zustand';
import { treeFilter } from '../lib/topicMatch';
import { EMPTY_LEVEL, type TopicNode } from '../lib/topicTree';

/**
 * filter is the identity; label differs only for tree nodes ('sensors/room' vs 'sensors/room/#').
 *
 * topic is what a colour rule about this selection should cover, which is not always the filter
 * the log is focused on: a leaf wants its own path, a branch wants its subtree. It is absent when
 * the selection is not a topic at all — the broker row is a connection, not something to colour.
 */
export type Selection = { label: string; filter: string; topic?: string };

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

/**
 * The selection a tree row makes.
 *
 * One place for it, because two places make it — the row itself, and the Manage panel taking a
 * reader back to a row they paused — and the two used to disagree about the label and the topic.
 * A leaf is one topic and a colour rule for it should say so; a branch stands for everything under
 * it. The empty first level is named by the slash that implies it: a pane saying 'No traffic on
 * yet.' names nothing.
 */
export function selectionFor(path: string, node: TopicNode | null): Selection {
  const filter = treeFilter(path);

  return {
    label: path === '' ? EMPTY_LEVEL : path,
    filter,
    topic: node !== null && node.children.size === 0 ? path : filter,
  };
}

/** The broker's row: everything, named by the broker, and nothing to colour. */
export const brokerSelection = (broker: string | undefined): Selection => ({
  label: broker ?? 'Not connected',
  filter: '#',
});
