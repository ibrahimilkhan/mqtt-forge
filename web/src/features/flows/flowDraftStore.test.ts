import { beforeEach, describe, expect, it } from 'vitest';
import { emptyFlow } from './flowDocument';
import { DRAFTS_KEY, useFlowDraftStore } from './flowDraftStore';

describe('flow drafts', () => {
  beforeEach(() => {
    localStorage.clear();
    useFlowDraftStore.setState({ drafts: {}, current: null, selected: null, refusals: {} });
  });

  it('starts a draft from the deployed flow on the first edit and builds on the draft after that', () => {
    const deployed = emptyFlow('Boiler watch');

    useFlowDraftStore.getState().edit(deployed, (flow) => ({ ...flow, name: 'Boiler house' }));
    useFlowDraftStore.getState().edit(deployed, (flow) => ({ ...flow, enabled: false }));

    expect(useFlowDraftStore.getState().drafts[deployed.id]).toMatchObject({ name: 'Boiler house', enabled: false });
  });

  it('keeps drafts through a reload', () => {
    const flow = emptyFlow('Kept');
    useFlowDraftStore.getState().put(flow);

    expect(JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? '{}').state.drafts[flow.id].name).toBe('Kept');
  });

  it('rehydrates drafts and the flow on screen from a stored payload', async () => {
    const flow = emptyFlow('Restored');
    localStorage.setItem(
      DRAFTS_KEY,
      JSON.stringify({ state: { drafts: { [flow.id]: flow }, current: flow.id }, version: 0 }),
    );

    await useFlowDraftStore.persist.rehydrate();

    expect(useFlowDraftStore.getState().drafts).toEqual({ [flow.id]: flow });
    expect(useFlowDraftStore.getState().current).toBe(flow.id);
  });

  it('forgets a draft, its refusal and its selection on discard', () => {
    const flow = emptyFlow('Doomed');
    const store = useFlowDraftStore.getState();
    store.put(flow);
    store.show(flow.id);
    store.refuse(flow.id, { 'node:n1': ['Pick a test.'] });
    store.select('n1');

    useFlowDraftStore.getState().discard(flow.id);

    expect(useFlowDraftStore.getState().drafts[flow.id]).toBeUndefined();
    expect(useFlowDraftStore.getState().refusals[flow.id]).toBeUndefined();
    expect(useFlowDraftStore.getState().selected).toBeNull();
  });

  it('keeps the selection when the flow discarded is not the one on screen', () => {
    const shown = emptyFlow('On screen');
    const other = emptyFlow('Elsewhere');
    const store = useFlowDraftStore.getState();
    store.put(shown);
    store.put(other);
    store.show(shown.id);
    store.select('n1');

    useFlowDraftStore.getState().discard(other.id);

    expect(useFlowDraftStore.getState().drafts[other.id]).toBeUndefined();
    expect(useFlowDraftStore.getState().selected).toBe('n1');
  });

  it('drops the draft and the refusal once the flow is deployed, and keeps what is on screen', () => {
    const flow = emptyFlow('Shipped');
    useFlowDraftStore.getState().put(flow);
    useFlowDraftStore.getState().show(flow.id);
    useFlowDraftStore.getState().refuse(flow.id, { flow: ['Name the flow.'] });

    useFlowDraftStore.getState().deployed(flow.id);

    expect(useFlowDraftStore.getState().drafts).toEqual({});
    expect(useFlowDraftStore.getState().refusals).toEqual({});
    expect(useFlowDraftStore.getState().current).toBe(flow.id);
  });

  it('forgets a flow that was deleted, moving off it if it was on screen', () => {
    const flow = emptyFlow('Deleted');
    useFlowDraftStore.getState().put(flow);
    useFlowDraftStore.getState().show(flow.id);

    useFlowDraftStore.getState().forget(flow.id);

    expect(useFlowDraftStore.getState().drafts).toEqual({});
    expect(useFlowDraftStore.getState().current).toBeNull();
  });

  it('shows a flow with nothing selected on it', () => {
    useFlowDraftStore.getState().select('n1');
    useFlowDraftStore.getState().show('f2');

    expect(useFlowDraftStore.getState().selected).toBeNull();
  });
});
