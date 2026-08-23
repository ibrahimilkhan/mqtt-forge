// '+' matches one segment; '#' matches the rest, including its own level.
export function matchesFilter(filter: string, topic: string): boolean {
  if (!filter) return false;

  const parts = filter.split('/');
  const segments = topic.split('/');

  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '#') return true;
    if (i >= segments.length) return false;
    if (parts[i] !== '+' && parts[i] !== segments[i]) return false;
  }

  return parts.length === segments.length;
}

// '#' covers the node's own topic plus everything beneath it.
export const treeFilter = (path: string): string => `${path}/#`;

/**
 * The path a `path/#` filter hangs off, or null for anything that does not name one — a filter
 * with a `+` in it, or the `#` that means every topic there is.
 *
 * Beside the matcher rather than in the tree, because both the tree and the log ask it the same
 * question and neither is asking about the other: it is the shape of the filter that is being
 * read, and nothing is walked to read it. What each of them does with the answer is the same
 * thing — start at the branch the filter names instead of matching everything they hold.
 */
export function filterPath(filter: string): string | null {
  if (!filter.endsWith('/#') || filter.includes('+')) return null;

  const path = filter.slice(0, -2);

  return path.includes('#') ? null : path;
}

/** Whether a filter names one topic and nothing else, so it can be looked up rather than matched. */
export const namesOneTopic = (filter: string): boolean =>
  filter !== '' && !filter.includes('#') && !filter.includes('+');
