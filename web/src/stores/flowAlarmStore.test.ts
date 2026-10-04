import { beforeEach, describe, expect, it } from 'vitest';
import type { FlowDto } from '../types/api';
import { alarmSource, isFlowAlarm, useFlowAlarmStore } from './flowAlarmStore';

/** A flow holding a Raise alarm node, and nothing else it needs here. */
const holding = (id: string, alarm: string): FlowDto => ({
  id,
  name: id,
  enabled: true,
  nodes: [{ id: alarm, type: 'alarmRaise', x: 0, y: 0, config: {} }],
  edges: [],
  variables: [],
});

beforeEach(() => useFlowAlarmStore.setState({ asked: null }));

describe('a flow alarm', () => {
  // The server's FlowAlarmBook names a flow alarm's rule `flow-{flowId}-{nodeId}`; a rule's own id
  // is a hex GUID the server gave it.
  it('is told from a rule\'s alarm by its rule id', () => {
    expect(isFlowAlarm('flow-watch-hot')).toBe(true);
    expect(isFlowAlarm('4f1c2a9be8d74e0f9a63c5d1b2e7f480')).toBe(false);
  });

  // A test run's alarms are its own, apart from the active run's: the server names them
  // `flowtest-{flowId}-{nodeId}`. They came from the flow all the same.
  it('is told by a test run\'s rule id too, and by no other start', () => {
    expect(isFlowAlarm('flowtest-f1-hot')).toBe(true);
    expect(alarmSource('flowtest-f1-hot', [holding('f1', 'hot')])).toEqual({ flowId: 'f1', nodeId: 'hot' });

    for (const ruleId of ['flows-f1-hot', 'test-f1-hot', 'flowtestf1-hot']) {
      expect(isFlowAlarm(ruleId)).toBe(false);
      expect(alarmSource(ruleId, [holding('f1', 'hot')])).toBeNull();
    }
  });

  // An id may itself hold a '-', so the rule id is read against the flows there are, not split.
  it('is traced to the flow and the Raise alarm node it came from, whatever their ids hold', () => {
    const flows = [holding('boiler', 'hot'), holding('boiler-2', 'hot')];

    expect(alarmSource('flow-boiler-2-hot', flows)).toEqual({ flowId: 'boiler-2', nodeId: 'hot' });
    expect(alarmSource('flow-boiler-hot', flows)).toEqual({ flowId: 'boiler', nodeId: 'hot' });
    expect(alarmSource('flow-boiler-cold', flows)).toBeNull();
    expect(alarmSource('flow-gone-hot', flows)).toBeNull();
  });

  it('is asked for until the page has answered', () => {
    useFlowAlarmStore.getState().ask('flow-watch-hot');
    expect(useFlowAlarmStore.getState().asked).toBe('flow-watch-hot');

    useFlowAlarmStore.getState().answered();
    expect(useFlowAlarmStore.getState().asked).toBeNull();
  });
});
