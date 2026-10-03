import { create } from 'zustand';
import type { FlowDto } from '../types/api';

/**
 * How a flow alarm's rule id starts: the server's FlowAlarmBook names one an active run raised
 * `flow-{flowId}-{nodeId}`, the flow and the Raise alarm node that raised it, and one a test run
 * raised `flowtest-{flowId}-{nodeId}`, so a test's alarms and the flow's own never touch. A rule's
 * own id is the hex GUID the server gave it; only a rules file written by hand could hold one that
 * starts either way.
 */
const FLOW_ALARMS = ['flow-', 'flowtest-'] as const;

/** Whether an alarm came from a flow's Raise alarm node, in a test or not, rather than from an alert rule. */
export const isFlowAlarm = (ruleId: string) => FLOW_ALARMS.some((start) => ruleId.startsWith(start));

/**
 * The flow and the Raise alarm node a flow alarm came from, among these flows, or null when none of
 * them has it. An id may itself hold a '-', and "flow-a-b-c" does not say where the flow's id ends,
 * so the rule id is read against the flows there are rather than split: the flow it starts with
 * that has a node by the rest of it.
 */
export function alarmSource(ruleId: string, flows: readonly FlowDto[]): { flowId: string; nodeId: string } | null {
  for (const flow of flows)
    for (const kind of FLOW_ALARMS) {
      const start = `${kind}${flow.id}-`;
      if (!ruleId.startsWith(start)) continue;

      const nodeId = ruleId.slice(start.length);
      if (flow.nodes.some((node) => node.id === nodeId)) return { flowId: flow.id, nodeId };
    }

  return null;
}

type FlowAlarmState = {
  /** A flow alarm's rule id the reader asked to see, until the Flows page has shown where it came from. */
  asked: string | null;
  ask: (ruleId: string) => void;
  /** The page has shown it, or found nothing left to show. */
  answered: () => void;
};

/**
 * Which flow alarm the Flows page is to open on.
 *
 * In the main chunk, because what asks is: the alarm wall's row for a flow alarm. The page is a
 * chunk of its own that may not have loaded yet, so the question waits here for it, and the page
 * answers once it has read the flows and can find the one the alarm came from.
 */
export const useFlowAlarmStore = create<FlowAlarmState>()((set) => ({
  asked: null,
  ask: (ruleId) => set({ asked: ruleId }),
  answered: () => set({ asked: null }),
}));
