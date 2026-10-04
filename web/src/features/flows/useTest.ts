import { useMutation } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { isFlowInvalid, isTestUnknown, stopTest, testFlow } from '../../api/flows';
import { own } from '../../lib/own';
import { isLive, useFlowStatusStore, type FlowRuns, type FlowStatusState } from '../../stores/flowStatusStore';
import { logFault } from '../../stores/logStore';
import type { FlowDto } from '../../types/api';
import { useFlowDraftStore } from './flowDraftStore';

/**
 * How long a press holds its button off at the most once it has been answered, when no push of the
 * numbers comes to say that what it asked for has happened: a hub that has gone away pushes nothing,
 * and a button must not be off for good for want of a push.
 */
export const HOLD_MS = 3_000;

/** No flow held off. One set, so a page with nothing held is handed the same one each time. */
const NONE: ReadonlySet<string> = new Set();

/**
 * A flow held off: the picture of the runs from which a push counts for it — null while none does —
 * and what frees it should none come.
 */
type Holding = { since: FlowStatusState['runs'] | null; timer?: ReturnType<typeof setTimeout> };

/**
 * Flows whose button is held off, each from its press until a push of the numbers says that what was
 * pressed has come about (`done`), or until HOLD_MS after the press was answered at the most.
 *
 * Only a push after the answer counts: one the server sent before it did what was asked says nothing
 * about it — the test it starts is not on the server until then, and the one it stops may be going
 * still. Stop's is no different, though the server may stop the test at any moment after the press:
 * the toolbar draws Test and not Stop once the numbers say the test is not going, so a push counted
 * early would free a button nobody sees, and the next push frees it a quarter of a second on.
 *
 * The fallback is counted from the answer as well. Counted from the press, a request the server was
 * slow to answer ran its three seconds out before the answer came, and the button was let go with the
 * numbers still to catch up: the press the hold is for. Every push builds a new picture of the runs,
 * which is what makes an identity check enough (see catchUp).
 *
 * Held as the press is made, in a ref as well as for the next render: a second click that comes
 * before the page has drawn the first one's finds the flow held already.
 */
function useHeld(done: (runs: FlowRuns | undefined) => boolean) {
  const [held, setHeld] = useState<ReadonlySet<string>>(NONE);
  const holding = useRef(new Map<string, Holding>());

  const told = useCallback(() => setHeld(holding.current.size === 0 ? NONE : new Set(holding.current.keys())), []);

  const free = useCallback(
    (id: string) => {
      const one = holding.current.get(id);
      if (one === undefined) return;
      clearTimeout(one.timer);
      holding.current.delete(id);
      told();
    },
    [told],
  );

  /** The press was answered: from now, a push can free the flow's button, and HOLD_MS will. */
  const answered = useCallback(
    (id: string) => {
      clearTimeout(holding.current.get(id)?.timer);
      holding.current.set(id, { since: useFlowStatusStore.getState().runs, timer: setTimeout(() => free(id), HOLD_MS) });
      told();
    },
    [free, told],
  );

  /**
   * Holds the flow's button off from now: false when it already was. No push frees it, and no fallback
   * does, until the press is answered (see answered).
   */
  const hold = useCallback(
    (id: string) => {
      if (holding.current.has(id)) return false;
      holding.current.set(id, { since: null });
      told();
      return true;
    },
    [told],
  );

  useEffect(
    () =>
      useFlowStatusStore.subscribe(({ runs }) => {
        for (const [id, { since }] of holding.current) if (since !== null && runs !== since && done(own(runs, id))) free(id);
      }),
    [done, free],
  );

  // The page shut: nothing is left to free.
  useEffect(() => {
    const all = holding.current;
    return () => {
      for (const { timer } of all.values()) clearTimeout(timer);
      all.clear();
    };
  }, []);

  return { held, hold, answered, free };
}

/**
 * A test of the flow is on show: the one just started, going or already over. The numbers carry no id
 * for a run, so this cannot tell the one just started from the flow's previous test, which the server
 * keeps, finished or stopped, until another replaces it. A push the server made just before it took
 * the new test, and that reaches the console after the answer, shows the previous one, and frees
 * Test early: a press in the quarter of a second before the next push starts the test over. Nothing
 * in FlowRunStatusDto says which test a picture is of, so the hold cannot be made exact from here.
 */
const tested = (runs: FlowRuns | undefined) => runs?.test !== undefined;

/** No test of the flow is going: the one just stopped has stopped, or is gone. */
const stopped = (runs: FlowRuns | undefined) => !isLive(runs?.test);

/**
 * Test and Stop for the flow on screen. A test runs the flow as drawn — its draft, unsaved — once,
 * beside the run it may have switched on, and touches nothing of that. What the server refuses is
 * filed on the flow, as a refused save is, and marked on its nodes; a test that starts lets an
 * earlier refusal go, since the drawing it was about is not the one running now.
 *
 * A flow with no draft is tested as the server has it, and what the server refuses of that copy is
 * filed all the same: it has no draft to go with, and stands until a test of the flow starts, the
 * flow is saved, or the server has another copy of it, or none (see refusedCopies). One sent as a
 * draft that was let go while the request was out has nothing left for it to be about, and is not
 * filed (see refuse).
 *
 * A start answers with what the server refused — the very object it asks the store to file, so the
 * page can tell this refusal from one filed since — or null once the test has started.
 *
 * Stop on a test the server no longer has is the run already over, which is what was asked.
 *
 * Each press holds its own button off, for that flow, until a push says it is done (see useHeld). The
 * button the page draws is the numbers', and they come up to a quarter of a second after the answer:
 * in between, Test is still Test and Stop still Stop, and pressed again, neither does what it says.
 * Test again started the test over, and sent its alarms, notices and tones again. Stop again found the
 * test stopped, and the server throws away a test that is not going: "Test · stopped" and its counters
 * went with it. So each is held from its press: Stop until a push after the server answered shows the
 * test no longer going, and Test until one shows the test — freed at once by a press that did not go
 * through, which can be made again, and at the latest HOLD_MS after the answer.
 */
export function useTest() {
  const starting = useHeld(tested);
  const stopping = useHeld(stopped);

  const start = useMutation({
    mutationFn: async (flow: FlowDto): Promise<Record<string, string[]> | null> => {
      // Whether what goes is a draft, as it goes: see refuse.
      const drafted = Object.hasOwn(useFlowDraftStore.getState().drafts, flow.id);

      try {
        await testFlow(flow);
        useFlowDraftStore.getState().lapse([flow.id]);
        starting.answered(flow.id);
        return null;
      } catch (error) {
        starting.free(flow.id);
        if (!isFlowInvalid(error)) throw error;

        const refused = error.errors ?? { flow: [error.message] };
        useFlowDraftStore.getState().refuse(flow, drafted, refused);
        return refused;
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
      stopping.answered(id);
    },
    onError: (error, id) => {
      stopping.free(id);
      logFault('Test not stopped', error);
    },
  });

  return {
    start,
    stop,
    /** Flows whose Test is held off: pressed, and no push since the server took it shows the test yet. */
    starting: starting.held,
    /** Flows whose Stop is held off: pressed, and no push since the server answered shows the test stopped yet. */
    stopping: stopping.held,
    /** Test pressed: sends nothing while the flow's Test is held off. */
    run: (flow: FlowDto) => {
      if (starting.hold(flow.id)) start.mutate(flow);
    },
    /** Stop pressed: sends nothing while the flow's Stop is held off. */
    halt: (id: string) => {
      if (stopping.hold(id)) stop.mutate(id);
    },
  };
}
