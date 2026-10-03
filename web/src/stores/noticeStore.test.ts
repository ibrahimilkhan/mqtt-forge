import { beforeEach, describe, expect, it } from 'vitest';
import type { FlowNoticeDto } from '../types/api';
import { NOTICES_SHOWN, useNoticeStore } from './noticeStore';

const notice = (text: string): FlowNoticeDto => ({
  flowId: 'watch', flowName: 'Boiler watch', nodeId: 'tell', text, level: 'warn', at: '2026-10-03T09:00:00Z', test: false,
});

const state = () => useNoticeStore.getState();

describe('notice store', () => {
  beforeEach(() => useNoticeStore.setState(useNoticeStore.getInitialState()));

  it('puts the newest notice first and keeps no more than are shown', () => {
    state().add([notice('a'), notice('b')]);
    state().add([notice('c'), notice('d'), notice('e')]);

    expect(state().notices.map((one) => one.text)).toEqual(['e', 'd', 'c', 'b'].slice(0, NOTICES_SHOWN));
  });

  it('gives every notice its own id, and lets one go by it', () => {
    state().add([notice('a'), notice('b')]);
    const [b, a] = state().notices;

    expect(a.id).not.toBe(b.id);
    state().dismiss(b.id);
    expect(state().notices.map((one) => one.text)).toEqual(['a']);
  });
});
