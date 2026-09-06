import { useLogStore } from './logStore';
import { useSearchStore } from './searchStore';
import { useTopicTreeStore } from './topicTreeStore';

/**
 * Everything the console is holding, let go: the tree of topics and the run behind every one.
 *
 * Both together, always. The two hold one thing between them — a topic's row and that topic's
 * messages — and a console that emptied one of them would leave rows in the tree whose runs are
 * gone, which is the fault the log's own shape was built to end: click a row, be told nothing
 * ever arrived.
 *
 * The tree's reset is what the console already does on every new connection, so this is that
 * same fresh start asked for by hand. The searches go with it because a box still holding
 * `boiler` over an empty pane reads as a pane with nothing in it rather than as a pane that has
 * just been emptied.
 *
 * What it does not touch: the record of what the link has done, which has its own control on its
 * own card, and what the broker is holding — a retained message cleared here comes back on the
 * next subscribe, because it was never this console's to let go of.
 */
export function clearTraffic(): void {
  useTopicTreeStore.getState().reset();
  useLogStore.getState().clear();
  useSearchStore.getState().clear();
}
