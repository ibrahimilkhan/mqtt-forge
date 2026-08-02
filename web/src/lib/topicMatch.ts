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
