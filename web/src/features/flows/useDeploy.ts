import { useMutation, useQueryClient } from '@tanstack/react-query';
import { isFlowInvalid, putFlow } from '../../api/flows';
import { queryKeys } from '../../api/queryKeys';
import { logFault } from '../../stores/logStore';
import type { FlowDto, FlowsDto } from '../../types/api';
import { fingerprint, sameFlow } from './flowDocument';
import { useFlowDraftStore } from './flowDraftStore';

/**
 * Deploys flows one at a time, each on its own request.
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
    mutationFn: async (flows: FlowDto[]) => {
      for (const flow of flows) {
        try {
          const { flow: kept } = await putFlow(flow);

          // A read of the list already on its way — the window came back into focus, say — was
          // answered before this flow was kept. Let in after the write below, it would put the
          // old flow back under a tab whose draft is about to go.
          await queryClient.cancelQueries({ queryKey: queryKeys.flows });
          queryClient.setQueryData<FlowsDto>(queryKeys.flows, (old) =>
            old && {
              ...old,
              flows: old.flows.some((one) => one.id === kept.id)
                ? old.flows.map((one) => (one.id === kept.id ? kept : one))
                : [...old.flows, kept],
              problems: old.problems.filter((problem) => problem.flowId !== kept.id),
            },
          );

          // What was typed while the request was out is an edit of the copy just kept.
          const store = useFlowDraftStore.getState();
          const since = store.drafts[flow.id];
          store.deployed(flow.id);
          if (since !== undefined && !sameFlow(since, flow)) store.put(since, fingerprint(kept));
        } catch (error) {
          if (!isFlowInvalid(error)) throw error;
          useFlowDraftStore.getState().refuse(flow.id, error.errors ?? { flow: [error.message] });
        }
      }
    },
    onError: (error) => logFault('Flows not deployed', error),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: queryKeys.flows }),
  });
}
