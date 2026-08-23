import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { queryKeys } from '../api/queryKeys';
import { createFrameBuffer } from '../lib/frameBuffer';
import { useHubStatusStore } from '../stores/hubStatusStore';
import { useHealthStore } from '../stores/healthStore';
import { MAX_LOG_ENTRIES, useLogStore } from '../stores/logStore';
import { usePauseStore } from '../stores/pauseStore';
import { useTopicTreeStore } from '../stores/topicTreeStore';
import type { MqttMessage } from '../types/api';
import { decodeIncoming } from './decodeIncoming';
import type { Hub } from './hub';

/**
 * How many messages one frame may take in.
 *
 * The work per message is a decode, a log append and a tree apply, and the frame that does it
 * also has to draw. Two thousand is what a mid-range laptop takes in comfortably inside a frame,
 * and it means a stop of five thousand is caught up in three frames — before the reader's finger
 * is off the button — while a stop of half a million comes in over four seconds rather than in
 * one locked frame.
 */
const PER_FRAME = 2_000;

// Where hub events meet application state; mounted once, from App.
export function useHubBridge(hub: Hub) {
  const queryClient = useQueryClient();

  useEffect(() => {
    // Declared before the queue so the queue can be asked, on the way out of a flush, how much
    // of it is left. Hoisted, so the reference is sound by the time a frame can fire.
    function take(batch: MqttMessage[]) {
      const started = performance.now();

      const decoded = batch.map(decodeIncoming);
      useLogStore.getState().appendReceived(decoded);
      useTopicTreeStore.getState().apply(decoded);

      // What taking the messages in cost, which is not what drawing them costs — the line that
      // reads this says both, because the second is the larger of the two.
      useHealthStore.getState().took(batch.length, performance.now() - started);
      usePauseStore.getState().track(buffer.waiting());
    }

    const buffer = createFrameBuffer<MqttMessage>(take, {
      // A stop of any length ends in a queue, and handing all of it over in one frame is the
      // avalanche that stopping used to be designed around. At sixty frames a second this is a
      // hundred and twenty thousand messages a second — faster than any broker this watches —
      // and the window goes on answering while it drains.
      perFrame: PER_FRAME,
      // What the log itself can hold. Past this the oldest go, which is exactly what the log's
      // own ring would have done to them, so nothing is lost that the console could have shown.
      ceiling: MAX_LOG_ENTRIES,
      onOverflow: (lost) => usePauseStore.getState().lose(lost),
    });

    // Stopping holds the queue rather than emptying it: what went past while the reader was
    // looking is what they stopped the console to look at.
    const stopWatching = usePauseStore.subscribe((state, previous) => {
      if (state.paused === previous.paused) return;

      if (state.paused) buffer.hold();
      else buffer.release();
    });

    // A connection resets the tree, and everything queued behind a stop was meant for the tree
    // that has just gone: it came from another broker, or from before this one's retained
    // messages refilled the tree, and either way handing it over now would write older readings
    // over newer ones. This is the one place messages are let go of on purpose.
    //
    // The log goes with it, for the same reason and one the queue does not have: what it holds is
    // already on screen. The tree used to start again on its own while the log kept every run
    // behind it, so a selection made on the broker just left went on drawing that broker's
    // traffic under a lamp reading Connected to the new one. Cleared here rather than beside the
    // reset, so anything that starts a tree starts a log with it.
    //
    // The selection is deliberately kept. Reconnecting to the same broker is the ordinary case,
    // and a selection whose run has been emptied says 'No traffic on … yet' and then fills as the
    // retained messages arrive — where clearing it would cost the reader a click for nothing.
    const stopWatchingTree = useTopicTreeStore.subscribe((state, previous) => {
      if (state.generation === previous.generation) return;

      usePauseStore.getState().lose(buffer.forget());
      usePauseStore.getState().track(0);
      // Fires inside reset(), so the 'Connected' line pushed after it survives.
      useLogStore.getState().clear();
    });

    const unsubscribe = hub.subscribe({
      messagesReceived: (messages) => {
        buffer.pushAll(messages);
        usePauseStore.getState().track(buffer.waiting());
      },
      connectionStateChanged: (payload) => queryClient.setQueryData(queryKeys.connection, payload),
      reconnecting: () => useHubStatusStore.getState().setStatus('reconnecting'),
      // Broker state may have moved on while the hub was down; refetch, don't trust the cache.
      reconnected: () => {
        useHubStatusStore.getState().setStatus('live');
        void queryClient.invalidateQueries();
      },
    });

    // Hub keeps retrying on its own; this just quiets the unhandled rejection and sets status.
    hub.start().catch(() => useHubStatusStore.getState().setStatus('reconnecting'));

    return () => {
      stopWatching();
      stopWatchingTree();
      unsubscribe();
      buffer.cancel();
      // The queue went with the buffer, so the figure the control reads has to go with it too.
      usePauseStore.getState().track(0);
    };
  }, [hub, queryClient]);
}
