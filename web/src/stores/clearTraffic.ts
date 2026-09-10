import { matchesFilter } from '../lib/topicMatch';
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

/**
 * What the pane is showing, let go — and nothing else.
 *
 * The log's own Clear used to call `clearTraffic` above, so emptying the pane on one topic took
 * the whole tree with it: every other broker's topic, every branch the reader had opened, gone
 * because they wanted this one run out of the way. The button stands over one selection and now
 * answers for exactly that: the runs the selection covers, whether it names one topic or a
 * branch of a thousand.
 *
 * Two answers, because a reader emptying a pane means one of two things. All of it, and the
 * topic goes from the tree with its run — a row whose messages are gone is the fault this
 * console's shape exists to prevent: click it, be told nothing ever arrived. Or all but the
 * newest, which is the pane cleared with the reading left on it: the tree keeps the row, and the
 * value on that row is the message still in the run behind it.
 *
 * The search goes either way: a box still holding `boiler` over a pane that has just been emptied
 * reads as a pane with nothing in it.
 */
export function clearSelection(filter: string, keep: 'nothing' | 'the newest'): void {
  const topics = [...useLogStore.getState().byTopic.keys()].filter((topic) =>
    matchesFilter(filter, topic),
  );

  if (keep === 'the newest') {
    useLogStore.getState().keepNewestOn(topics);
  } else {
    useLogStore.getState().forgetTopics(topics);
    // Nothing is kept, so nothing else is still holding these rows up: the second argument is the
    // filters that would, and a reader clearing a pane is not unsubscribing from anything.
    useTopicTreeStore.getState().dropFilter(filter, []);
  }

  useSearchStore.getState().clear();
}
