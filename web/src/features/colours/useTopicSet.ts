import { useEffect, useState } from 'react';
import { useTopicTreeStore } from '../../stores/topicTreeStore';

/** The most often a changing set of topics is answered: a count is read, not watched. */
const AT_MOST_EVERY_MS = 1_000;

type Tree = ReturnType<typeof useTopicTreeStore.getState>;

/**
 * Which topics the tree holds, in as few words as tell two sets apart.
 *
 * A topic is added, given up to the ceiling, or cleared away, and a tree is started again; each
 * moves one of these. A new reading on a topic already there moves none of them — which is
 * nearly every message a broker sends, and the whole point.
 */
const shape = (tree: Tree) => `${tree.generation}:${tree.root.subTopics}:${tree.forgotten}`;

/**
 * A number that goes up when the set of topics in the tree has changed, at most once a second.
 *
 * For what is worked out over every topic but does not care what any of them last said: the
 * colour rules' counts. Read off the root, those were taken again on every frame of traffic —
 * the root is new on each one — and a walk of forty thousand topics sixty times a second is what
 * the console stuttered on whenever the Colours panel was open. Only the set is followed here,
 * and on a broker whose topics churn, so that the set changes every frame too, it is answered
 * on a beat rather than on each.
 */
export function useTopicSet(): number {
  const [changes, setChanges] = useState(0);

  useEffect(() => {
    let last = shape(useTopicTreeStore.getState());
    let answeredAt = -Infinity;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const answer = () => {
      timer = undefined;
      answeredAt = performance.now();
      setChanges((count) => count + 1);
    };

    const stop = useTopicTreeStore.subscribe((tree) => {
      const now = shape(tree);
      if (now === last) return;
      last = now;

      // Already booked: it will read the tree as it stands then, this change included.
      if (timer !== undefined) return;
      timer = setTimeout(answer, Math.max(0, answeredAt + AT_MOST_EVERY_MS - performance.now()));
    });

    return () => {
      stop();
      clearTimeout(timer);
    };
  }, []);

  return changes;
}
