import { useEffect } from 'react';
import { useConnectionState } from '../../api/useConnectionState';
import { useLinkWatchStore } from '../../stores/linkWatchStore';

/**
 * Feeds the link watch from the connection state, once, for the whole console.
 *
 * Mounted from App rather than from the Broker panel, and that is the point: the panel is shut
 * most of the time, and a drop that happened while it was shut is exactly the drop the reader
 * most needs told about. A watcher that only ran while the panel was open would miss every one
 * of them.
 */
export function useLinkWatch() {
  const { state, failure, answered } = useConnectionState();

  useEffect(() => {
    // Before the API has answered, `state` is the standing-in Disconnected rather than an
    // observation — and Disconnected is the one value that clears the store. A console reloaded
    // over a broken link would wipe the outage it was reloaded to look at.
    if (!answered) return;

    useLinkWatchStore.getState().saw(state, failure);
  }, [state, failure, answered]);
}
