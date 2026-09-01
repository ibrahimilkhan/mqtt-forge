import { createRuleLookup, type ColourRule } from '../../lib/topicColour';
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
 */
export function paintedBy(
  root: TopicNode,
  rules: readonly ColourRule[],
): ReadonlyMap<string, number> {
  const painted = new Map<string, number>();
  for (const rule of rules) painted.set(rule.filter, 0);

  // A rule with no filter yet is not a rule; asking the lookup about it would make '' match
  // nothing and cost a walk of the whole tree to find that out.
  const asked = rules.filter((rule) => rule.filter !== '');
  if (asked.length === 0) return painted;

  const winner = createRuleLookup(asked);

  const stack: Array<{ node: TopicNode; path: string; isRoot: boolean }> = [
    { node: root, path: '', isRoot: true },
  ];

  while (stack.length > 0) {
    const { node, path, isRoot } = stack.pop()!;

    // Topics, not branches. A branch that has never carried a message of its own is a level in a
    // path rather than something a colour is drawn on.
    if (!isRoot && node.hits > 0) {
      const rule = winner(path);
      if (rule) painted.set(rule.filter, (painted.get(rule.filter) ?? 0) + 1);
    }

    for (const [name, child] of node.children) {
      stack.push({ node: child, path: isRoot ? name : `${path}/${name}`, isRoot: false });
    }
  }

  return painted;
}
