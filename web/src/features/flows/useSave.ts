import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { getFlows, isFlowInvalid, putFlow } from '../../api/flows';
import { queryKeys } from '../../api/queryKeys';
import { ApiError, describeError } from '../../lib/problemDetails';
import { logFault } from '../../stores/logStore';
import type { FlowDto, FlowsDto } from '../../types/api';
import { fingerprint, sameFlow, standingOf, titleOf } from './flowDocument';
import { useFlowDraftStore } from './flowDraftStore';

/**
 * Puts what the server now has of one flow into the list the page reads — `kept`, or nothing once
 * it is deleted — with no problems filed against it, without waiting for the read that follows.
 *
 * A read of the list already on its way — the window came back into focus, say — was answered
 * before this, and let in after it would put the old flow back. So it is called off first.
 */
export async function putInList(queryClient: QueryClient, id: string, kept: FlowDto | null) {
  await queryClient.cancelQueries({ queryKey: queryKeys.flows });
  queryClient.setQueryData<FlowsDto>(queryKeys.flows, (old) => {
    if (!old) return old;

    const others = old.flows.filter((one) => one.id !== id);
    // A kept flow stays where it was in the list, so its tab does not move.
    const flows =
      kept === null
        ? others
        : old.flows.some((one) => one.id === id)
          ? old.flows.map((one) => (one.id === id ? kept : one))
          : [...old.flows, kept];
    return { ...old, flows, problems: old.problems.filter((problem) => problem.flowId !== id) };
  });
}

/** A flow the server refused, by its id and by the name it was sent with. */
export type Refused = { id: string; name: string };

/**
 * What a save says when the list could not be read before it. Nothing was sent: without the
 * server's copy there is no telling whether another console has overtaken the draft since.
 */
const unread = (error: unknown) =>
  new ApiError(
    error instanceof ApiError ? error.status : 0,
    `The flows could not be read from the server first, so nothing was sent. ${describeError(error)}`,
  );

/**
 * Saves the flow on screen, switched on or off, on its own request, and answers with it when the
 * server refused it.
 *
 * It reads the list first, as Deploy did: a draft started from a copy another console has since
 * replaced or deleted is held back rather than sent over it (see standingOf), and only a list read
 * now can tell. A list that cannot be read sends nothing, and says so. What the server keeps goes
 * into the list before the draft it was sent from goes, and what was typed while the request was
 * out stays a draft of the copy just kept.
 *
 * Deactivate sends the server's copy, not the draft: the run stops however the drawing stands. The
 * copy is the one in the list just read, so a flow another console has saved since goes back
 * switched off as that console left it, not as this page last saw it; and one the server no longer
 * has, or has switched off already, is left as it is. What the server refuses of that copy is not
 * about the drawing, so it is not marked there: it fails the save, which says why.
 */
export function useSave() {
  const queryClient = useQueryClient();

  return useMutation({
    // Only Deactivate sends `enabled: false`, and it sends the server's copy rather than the
    // drawing: Activate and Update send the flow as drawn, switched on.
    mutationFn: async ({ flow, enabled }: { flow: FlowDto; enabled: boolean }): Promise<Refused | null> => {
      const drawing = enabled;
      // Whether what goes is a draft, or the server's own copy of a flow with none: see below.
      const drafted = flow.id in useFlowDraftStore.getState().drafts;

      // Asked here rather than through the query's fetchQuery, whose read the page can cancel while
      // it is out — a delete's answer cancels the list's reads — and a cancelled fetchQuery hands
      // back the list the cache already had, without a word.
      let read: FlowsDto;
      try {
        read = await getFlows();
      } catch (error) {
        throw unread(error);
      }

      // A read of the list still out set off before this one did: let in after it, it would put the
      // older list back. The list is put where the page reads it, so the page marks a draft this
      // holds back as held back.
      await queryClient.cancelQueries({ queryKey: queryKeys.flows });
      queryClient.setQueryData<FlowsDto>(queryKeys.flows, read);
      // As the cache keeps it: a copy that has not changed is still the object the page worked out
      // its answers about.
      const now = queryClient.getQueryData<FlowsDto>(queryKeys.flows) ?? read;
      if (now.unreadable) return null;

      const copy = now.flows.find((one) => one.id === flow.id);
      const { bases } = useFlowDraftStore.getState();
      if (drawing && standingOf(flow, bases[flow.id] ?? null, copy) === 'overtaken') return null;

      // Deactivate has nothing to switch off when the server has no copy, or has it off already.
      const sent = drawing ? flow : copy?.enabled ? copy : null;
      if (sent === null) return null;

      try {
        const { flow: kept } = await putFlow({ ...sent, enabled });
        // Before the draft goes, so the tab never shows the old flow in between.
        await putInList(queryClient, kept.id, kept);

        if (drawing) {
          // What was typed while the request was out is an edit of the copy just kept. What the
          // server refused of an earlier drawing goes with the draft it was about.
          const store = useFlowDraftStore.getState();
          const since = store.drafts[flow.id];
          store.settle([flow.id]);
          if (since !== undefined && !sameFlow(since, flow)) store.put(since, fingerprint(kept));
        }
        return null;
      } catch (error) {
        if (!drawing || !isFlowInvalid(error)) throw error;

        // Marked on the drawing it is about. A draft let go while the request was out — discarded,
        // or taken back — has nothing left for it to be about.
        const store = useFlowDraftStore.getState();
        if (!drafted || flow.id in store.drafts) store.refuse(flow.id, error.errors ?? { flow: [error.message] });
        return { id: flow.id, name: titleOf(flow) };
      }
    },
    onError: (error) => logFault('Flow not saved', error),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: queryKeys.flows }),
  });
}
