import { matchesFilter, showsTopic } from '../lib/topicMatch';
import { useHoldStore } from './holdStore';
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
 * Topics gone from every place the console keeps one: the tree, the log's runs, and every hold.
 *
 * All three, always. The tree and the log hold one thing between them — a row and its run — and a
 * console that emptied one left the fault this shape exists to prevent. Holds are the third: a
 * pause kept the runs it had frozen, so a pane the reader had just emptied went on showing them,
 * and the topic's next message brought its row back with the value from before. A hold above what
 * went keeps standing without it; one with nothing left is let go.
 */
export function forgetTopics(remove: (topic: string) => boolean): void {
  const log = useLogStore.getState();
  log.forgetTopics([...log.byTopic.keys()].filter(remove));
  useTopicTreeStore.getState().dropTopics(remove);
  useHoldStore.getState().forget(remove, 'nothing');
}

/**
 * What the pane is showing, let go — and nothing else.
 *
 * The log's own Clear used to empty the whole tree, because a reader wanted one run out of the
 * way. It answers for the selection now, with what the selection shows: the broker's row shows
 * everything this console holds, `$SYS` included, and its Clear takes all of that.
 *
 * Two answers, because a reader emptying a pane means one of two things. All of it, and the topic
 * goes from the tree with its run. Or all but the newest, which is the pane cleared with the
 * reading left on it: the rows stay, and so do the rows a hold froze, with their runs cut back too.
 *
 * The search goes either way: a box still holding `boiler` over a pane that has just been emptied
 * reads as a pane with nothing in it.
 */
export function clearSelection(filter: string, keep: 'nothing' | 'the newest'): void {
  const shows = (topic: string) => showsTopic(filter, topic);

  if (keep === 'the newest') {
    const log = useLogStore.getState();
    log.keepNewestOn([...log.byTopic.keys()].filter(shows));
    useHoldStore.getState().forget(shows, 'the newest');
  } else {
    forgetTopics(shows);
  }

  useSearchStore.getState().clear();
}

/**
 * What an unsubscribe takes with it: the topics no filter the console still holds covers.
 *
 * Asked the broker's way, with matchesFilter — a subscription decides what arrives, and `#` still
 * up means `sensors/#` going changes nothing about `sensors/temp`.
 */
export function forgetUnsubscribed(filter: string, stillSubscribed: readonly string[]): void {
  forgetTopics(
    (topic) =>
      matchesFilter(filter, topic) && !stillSubscribed.some((kept) => matchesFilter(kept, topic)),
  );
}
