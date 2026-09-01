import { useQuery } from '@tanstack/react-query';
import { arrived, type ReconnectView } from '../features/connection/reconnectView';
import { getReconnectStatus } from './connection';
import { queryKeys } from './queryKeys';

/**
 * What the supervisor is doing about the link.
 *
 * Asked for once and pushed thereafter — the hub writes this same key on every change, exactly as
 * it does for the connection state. Neither half is enough on its own: the push covers a console
 * that was watching, and the fetch covers one that has just been opened.
 *
 * Both halves go through `arrived`, so whatever is in the cache already carries a deadline on this
 * machine's clock. A component that had to convert would be a second place the skew arithmetic
 * lives, and the two would drift.
 */
// The standing-in value is "on, and nothing is wrong", which is what the shipped default and a
// quiet host both are. The alternative — undefined until the API answers — would have the panel
// flash a Reconnect block on every load of a console whose link is perfectly fine.
const UNANSWERED: ReconnectView = {
  enabled: true,
  active: false,
  attempt: 0,
  nextAttemptAt: null,
  gaveUp: false,
  now: '',
  dueAt: null,
};

export function useReconnectStatus() {
  const { data } = useQuery({
    queryKey: queryKeys.reconnect,
    queryFn: async () => arrived(await getReconnectStatus()),
  });

  return {
    status: data ?? UNANSWERED,
    /** Whether the answer above is the API's or the standing-in one. */
    answered: data !== undefined,
  };
}
