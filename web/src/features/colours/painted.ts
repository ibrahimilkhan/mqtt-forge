import { sortRules, type ColourRule } from '../../lib/topicColour';
import type { TopicNode } from '../../lib/topicTree';

/**
 * How many topics each rule is actually painting, right now.
 *
 * A colour rule is the one kind of rule in this console whose effect is somewhere else: it paints
 * rows in a tree two panels away, and the panel it is written in used to show a filter, a swatch
 * and nothing about whether either of them was doing anything. A filter with a typo in it looked
 * exactly like a filter that was painting forty topics — which is the same silent failure a wrong
 * alert filter has, and it deserves the same cure: say what it is seeing.
 *
 * Counted by the WINNER, not by the match. Two rules can cover one topic and only one of them
 * paints it — the more specific wins, wherever it happens to sit in the list — so a rule counted
 * by everything it matches would claim topics another rule has taken off it. A general rule under
 * a specific one reading 'none' is not a bug in this count; it is the count doing its job.
 *
 * It used to ask the painter's lookup about every topic in turn, which is the same question in
 * the same words but not at the same price: the lookup keeps every answer under the topic's full
 * name, and fifty thousand of those took most of a second — once a second, on a broker whose
 * topics churn. So the filters are walked down the tree a level at a time instead. A branch no
 * rule can reach is never entered, and a branch one rule's '#' has won outright is counted off
 * the node in one step. The rules are the painter's own, sorted the painter's way, and the tests
 * hold this to the painter's answer topic by topic.
 */
export function paintedBy(
  root: TopicNode,
  rules: readonly ColourRule[],
): ReadonlyMap<string, number> {
  const painted = new Map<string, number>();
  for (const rule of rules) painted.set(rule.filter, 0);

  // A rule with no filter yet is not a rule. The sort drops what the painter would not paint
  // with — a colour that is not a usable triple — and orders the rest the way it consults them.
  const sorted = sortRules(rules.filter((rule) => rule.filter !== ''));
  if (sorted.length === 0) return painted;

  const parts = sorted.map((rule) => rule.filter.split('/'));
  const credit = (at: number, topics: number) =>
    painted.set(sorted[at].filter, painted.get(sorted[at].filter)! + topics);

  /**
   * Where each rule still in the running stands, by its place in the sorted list: `covered` once
   * it has reached a '#' and takes everything beneath, `level` otherwise — the rule has matched
   * every segment down to this node. Kept in sorted order, so the first one is the winner.
   */
  type Standing = { at: number; covered: boolean };

  const stack: Array<{ node: TopicNode; depth: number; standing: Standing[] }> = [];
  const all = sorted.map((_, at) => ({ at, covered: false }));
  for (const name of root.order) {
    stack.push({ node: root.children.get(name)!, depth: 0, standing: all });
  }

  while (stack.length > 0) {
    const { node, depth, standing } = stack.pop()!;

    const here: Standing[] = [];
    for (const one of standing) {
      if (one.covered) {
        here.push(one);
        continue;
      }
      const part = parts[one.at][depth];
      // A leading wildcard never reaches a '$' topic — see matchesFilter for why.
      if (depth === 0 && (part === '#' || part === '+') && node.name.startsWith('$')) continue;
      if (part === '#') here.push({ at: one.at, covered: true });
      else if (part === '+' || part === node.name) here.push(one);
    }

    // Nobody can reach anything under here.
    if (here.length === 0) continue;

    // The winner takes the whole branch: every topic in it, counted without visiting one.
    if (here[0].covered) {
      credit(here[0].at, node.subTopics);
      continue;
    }

    // Topics, not branches. A branch that has never carried a message of its own is a level in a
    // path rather than something a colour is drawn on. The filter has to end here — or go on
    // only with a '#', which covers the level it hangs from.
    if (node.hits > 0) {
      const winner = here.find(({ at, covered }) => {
        if (covered) return true;
        const rest = parts[at].length - (depth + 1);
        return rest === 0 || (rest === 1 && parts[at][depth + 1] === '#');
      });
      if (winner) credit(winner.at, 1);
    }

    for (const name of node.order) {
      stack.push({ node: node.children.get(name)!, depth: depth + 1, standing: here });
    }
  }

  return painted;
}
