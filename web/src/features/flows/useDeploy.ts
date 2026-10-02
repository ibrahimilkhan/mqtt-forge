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
 * What a deploy says when the list could not be read before it. Nothing was sent: without the
 * server's copies there is no telling which drafts another console has overtaken since.
 */
const unread = (error: unknown) =>
  new ApiError(
    error instanceof ApiError ? error.status : 0,
    `The flows could not be read from the server first, so nothing was sent. ${describeError(error)}`,
  );

/**
 * Deploys flows one at a time, each on its own request, and answers with the ones it refused.
 *
 * It reads the list first. A draft started from a copy the server has since replaced or deleted is
 * held back rather than sent over it (see standingOf), and the page can only tell such a draft from
 * the list it read last — read again when the window comes back into focus, or the hub back from a
 * drop. Two consoles side by side on two screens do neither: one deploys, and the other goes on
 * showing the copy it read before. So each flow it was handed is weighed again against the list as
 * it is now, and only those still an edit of the server's copy, or new to it, go. The list is put
 * where the page reads it, so the page marks what was left out as held back. A list that cannot be
 * read sends nothing, and says so.
 *
 * A refusal is not a failure of the deploy: it is the server's answer about one flow, and the
 * others still go. It is filed against the flow so the page can mark the nodes it is about, and
 * the draft stays. Anything else — the server gone, a file it will not write over — stops the
 * run and goes to the log like every other failure the console meets.
 *
 * A flow that went through is written into the query cache before its draft is dropped, so the
 * tab never shows the old flow for the moment between the two. The draft that is dropped is the
 * one that was sent: a flow edited while its request was out comes back as a draft of the newer
 * version, because what was typed in that moment has not been deployed.
 */
export function useDeploy() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (flows: FlowDto[]): Promise<Refused[]> => {
      // Asked here rather than through the query's fetchQuery, whose read the page can cancel while
      // it is out — a delete's answer cancels the list's reads — and a cancelled fetchQuery hands
      // back the list the cache already had, without a word; or, had it joined a read already out,
      // fails with a cancellation nobody would understand. Either way Deploy would not have read.
      let read: FlowsDto;
      try {
        read = await getFlows();
      } catch (error) {
        throw unread(error);
      }

      // A read of the list still out set off before this one did: let in after it, it would put the
      // older list back.
      await queryClient.cancelQueries({ queryKey: queryKeys.flows });
      queryClient.setQueryData<FlowsDto>(queryKeys.flows, read);
      // As the cache keeps it: a copy that has not changed is still the object the page worked
      // out its answers about.
      const now = queryClient.getQueryData<FlowsDto>(queryKeys.flows) ?? read;

      const copies = new Map(now.flows.map((flow) => [flow.id, flow]));
      const { bases } = useFlowDraftStore.getState();
      const going = now.unreadable
        ? []
        : flows.filter(
            (flow) => standingOf(flow, bases[flow.id] ?? null, copies.get(flow.id)) === 'changed',
          );

      const refused: Refused[] = [];

      for (const flow of going) {
        try {
          const { flow: kept } = await putFlow(flow);

          // Before its draft goes, so the tab never shows the old flow in between.
          await putInList(queryClient, kept.id, kept);

          // What was typed while the request was out is an edit of the copy just kept.
          const store = useFlowDraftStore.getState();
          const since = store.drafts[flow.id];
          store.settle([flow.id]);
          if (since !== undefined && !sameFlow(since, flow)) store.put(since, fingerprint(kept));
        } catch (error) {
          if (!isFlowInvalid(error)) throw error;
          useFlowDraftStore.getState().refuse(flow.id, error.errors ?? { flow: [error.message] });
          refused.push({ id: flow.id, name: titleOf(flow) });
        }
      }

      return refused;
    },
    onError: (error) => logFault('Flows not deployed', error),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: queryKeys.flows }),
  });
}
