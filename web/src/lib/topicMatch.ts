// '+' matches one segment; '#' matches the rest, including its own level.
export function matchesFilter(filter: string, topic: string): boolean {
  if (!filter) return false;

  const parts = filter.split('/');
  const segments = topic.split('/');

  /* A filter that opens with a wildcard cannot reach a topic that opens with '$'.
   *
   * The specification's rule, and the console has to keep it because the broker does: '#' is not
   * how anybody's statistics are asked for, which is why Subscribe $SYS is a second filter of its
   * own. Without it the two subscriptions the console holds were handed to each other's rules —
   * a colour rule reading `+/broker/#` painted the broker's own tree, and an alert rule with the
   * same filter stood twenty-nine alarms up on `$SYS/broker/load/...`, which no broker would ever
   * have delivered under it. TopicFilterCover has had this rule since it was written; these two
   * did not. See TopicFilterMatch.cs, which is this function in C# and must agree with it. */
  if ((parts[0] === '#' || parts[0] === '+') && segments[0].startsWith('$')) return false;

  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '#') return true;
    if (i >= segments.length) return false;
    if (parts[i] !== '+' && parts[i] !== segments[i]) return false;
  }

  return parts.length === segments.length;
}

// '#' covers the node's own topic plus everything beneath it.
export const treeFilter = (path: string): string => `${path}/#`;
