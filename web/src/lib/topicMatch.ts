// MQTT filter matching: '+' stands for one segment, '#' for whatever is left — including the
// level it hangs off, so 'sensors/#' matches 'sensors' as well as 'sensors/room/temp'.
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

// A tree node stands for its own topic plus everything under it, and '#' covers both.
export const treeFilter = (path: string): string => `${path}/#`;
