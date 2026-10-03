import { useMutation } from '@tanstack/react-query';
import { isFlowInvalid, isTestUnknown, stopTest, testFlow } from '../../api/flows';
import { logFault } from '../../stores/logStore';
import type { FlowDto } from '../../types/api';
import { useFlowDraftStore } from './flowDraftStore';

/**
 * Test and Stop for the flow on screen. A test runs the flow as drawn — its draft, unsaved — once,
 * beside the run it may have switched on, and touches nothing of that. What the server refuses is
 * filed on the flow, as a refused save is, and marked on its nodes; a test that starts lets an
 * earlier refusal go, since the drawing it was about is not the one running now.
 *
 * A flow with no draft is tested as the server has it, and what the server refuses of that copy is
 * filed all the same: it has no draft to go with, and stands until a test of the flow starts or the
 * flow is saved. One sent as a draft that was let go while the request was out — discarded, or
 * taken back — has nothing left for it to be about, and is not filed.
 *
 * Stop on a test the server no longer has is the run already over, which is what was asked.
 */
export function useTest() {
  const start = useMutation({
    mutationFn: async (flow: FlowDto): Promise<'started' | 'refused'> => {
      const drafted = flow.id in useFlowDraftStore.getState().drafts;

      try {
        await testFlow(flow);
        useFlowDraftStore.getState().lapse([flow.id]);
        return 'started';
      } catch (error) {
        if (!isFlowInvalid(error)) throw error;

        const store = useFlowDraftStore.getState();
        if (!drafted || flow.id in store.drafts) store.refuse(flow.id, error.errors ?? { flow: [error.message] });
        return 'refused';
      }
    },
    onError: (error) => logFault('Test not started', error),
  });

  const stop = useMutation({
    mutationFn: async (id: string) => {
      try {
        await stopTest(id);
      } catch (error) {
        if (!isTestUnknown(error)) throw error;
      }
    },
    onError: (error) => logFault('Test not stopped', error),
  });

  return { start, stop };
}
