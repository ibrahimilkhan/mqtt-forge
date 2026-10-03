import { beforeEach, describe, expect, it } from 'vitest';
import type { FlowDto } from '../types/api';
import { alarmSource, isFlowAlarm, useFlowAlarmStore } from './flowAlarmStore';

/** A flow holding an Alarm node, and nothing else it needs here. */
const holding = (id: string, alarm: string): FlowDto => ({
  id,
  name: id,
  enabled: true,
  nodes: [{ id: alarm, type: 'alarm', x: 0, y: 0, config: {} }],
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

  // An id may itself hold a '-', so the rule id is read against the flows there are, not split.
  it('is traced to the flow and the Alarm node it came from, whatever their ids hold', () => {
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
