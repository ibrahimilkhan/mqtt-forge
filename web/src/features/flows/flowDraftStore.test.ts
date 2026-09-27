import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyFlow } from './flowDocument';
import { DRAFT_PREFIX, useFlowDraftStore } from './flowDraftStore';

/** Where every draft was kept together before each had a key of its own. */
const OLD_KEY = 'mqttforge.flows.drafts';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  useFlowDraftStore.setState({ drafts: {}, current: null, selected: null, refusals: {} });
});

/** The store as a page opened now would have it: a second copy, read afresh from what storage holds. */
async function reopened() {
  vi.resetModules();
  return (await import('./flowDraftStore')).useFlowDraftStore;
}

/** What localStorage holds, key by key. */
const held = () =>
  new Map(Array.from({ length: localStorage.length }, (_, at) => localStorage.key(at)!).map((key) => [key, localStorage.getItem(key)]));

/**
 * Tells every tab what changed in localStorage since `before`, the way a browser tells the other
 * tabs of one: an event for each key whose value changed.
 */
function announce(before: Map<string, string | null>) {
  const after = held();
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const oldValue = before.get(key) ?? null;
    const newValue = after.get(key) ?? null;
    if (oldValue !== newValue) window.dispatchEvent(new StorageEvent('storage', { key, oldValue, newValue, storageArea: localStorage }));
  }
}

describe('flow drafts', () => {
  it('starts a draft from the deployed flow on the first edit and builds on the draft after that', () => {
    const deployed = emptyFlow('Boiler watch');

    useFlowDraftStore.getState().edit(deployed, (flow) => ({ ...flow, name: 'Boiler house' }));
    useFlowDraftStore.getState().edit(deployed, (flow) => ({ ...flow, enabled: false }));

    expect(useFlowDraftStore.getState().drafts[deployed.id]).toMatchObject({ name: 'Boiler house', enabled: false });
  });

  it('keeps drafts and the flow on screen through a reload', async () => {
    const flow = emptyFlow('Kept');
    useFlowDraftStore.getState().put(flow);
    useFlowDraftStore.getState().show(flow.id);

    const reloaded = await reopened();

    expect(reloaded.getState().drafts).toEqual({ [flow.id]: flow });
    expect(reloaded.getState().current).toBe(flow.id);
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

  it('lets the refusals of flows back to what is running lapse, and keeps the drafts and the rest', () => {
    const back = emptyFlow('Back');
    const still = emptyFlow('Still refused');
    const store = useFlowDraftStore.getState();
    store.put(back);
    store.put(still);
    store.refuse(back.id, { flow: ['Name the flow.'] });
    store.refuse(still.id, { flow: ['Name the flow.'] });

    useFlowDraftStore.getState().lapse([back.id]);

    expect(Object.keys(useFlowDraftStore.getState().refusals)).toEqual([still.id]);
    expect(Object.keys(useFlowDraftStore.getState().drafts)).toEqual([back.id, still.id]);
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

describe('what storage keeps', () => {
  it('keeps each draft under a key of its own, in a shape that says its version', () => {
    const one = emptyFlow('One');
    const two = emptyFlow('Two');

    useFlowDraftStore.getState().put(one);
    useFlowDraftStore.getState().put(two);
    useFlowDraftStore.getState().discard(one.id);

    expect(localStorage.getItem(DRAFT_PREFIX + one.id)).toBeNull();
    expect(JSON.parse(localStorage.getItem(DRAFT_PREFIX + two.id)!)).toEqual({ version: 1, flow: two });
  });

  // Drafts kept before each had a key of their own are the reader's work: they move, not go.
  it('moves the drafts kept all together before, and the flow that was on screen, to keys of their own', async () => {
    const flow = emptyFlow('From before');
    localStorage.setItem(OLD_KEY, JSON.stringify({ state: { drafts: { [flow.id]: flow }, current: flow.id }, version: 0 }));

    const opened = await reopened();

    expect(opened.getState().drafts).toEqual({ [flow.id]: flow });
    expect(opened.getState().current).toBe(flow.id);
    expect(JSON.parse(localStorage.getItem(DRAFT_PREFIX + flow.id)!)).toEqual({ version: 1, flow });
    expect(localStorage.getItem(OLD_KEY)).toBeNull();

    // Moved, not only read: the next reload finds both where they are kept now.
    const again = await reopened();
    expect(again.getState().drafts).toEqual({ [flow.id]: flow });
    expect(again.getState().current).toBe(flow.id);
  });

  // Storage outlives the build that wrote it, and a hand in the devtools can write anything. One
  // draft short of a name took the whole page down on every open.
  it('drops a draft kept from before that is not a whole flow, and opens with the rest', async () => {
    const whole = emptyFlow('Whole');
    const noNodes = { ...emptyFlow('No nodes'), nodes: undefined };
    const oddNode = { ...emptyFlow('Odd node'), nodes: [{ id: 'n1', type: 'if' }] };
    localStorage.setItem(
      OLD_KEY,
      JSON.stringify({ state: { drafts: { [whole.id]: whole, broken: { id: 'broken' }, [noNodes.id]: noNodes, [oddNode.id]: oddNode }, current: 'broken' }, version: 0 }),
    );

    const opened = await reopened();

    expect(Object.keys(opened.getState().drafts)).toEqual([whole.id]);
  });

  it('drops a draft kept under its own key that is not a whole flow, and leaves one a newer build kept', async () => {
    const whole = emptyFlow('Whole');
    const newer = emptyFlow('Newer');
    localStorage.setItem(DRAFT_PREFIX + whole.id, JSON.stringify({ version: 1, flow: whole }));
    localStorage.setItem(`${DRAFT_PREFIX}broken`, JSON.stringify({ version: 1, flow: { id: 'broken' } }));
    localStorage.setItem(`${DRAFT_PREFIX}garbled`, '{"version":1,"fl');
    localStorage.setItem(`${DRAFT_PREFIX}bare`, JSON.stringify(emptyFlow('Bare')));
    localStorage.setItem(DRAFT_PREFIX + newer.id, JSON.stringify({ version: 2, flow: newer }));

    const opened = await reopened();

    expect(Object.keys(opened.getState().drafts)).toEqual([whole.id]);
    expect(localStorage.getItem(`${DRAFT_PREFIX}broken`)).toBeNull();
    expect(localStorage.getItem(`${DRAFT_PREFIX}garbled`)).toBeNull();
    expect(localStorage.getItem(`${DRAFT_PREFIX}bare`)).toBeNull();
    expect(localStorage.getItem(DRAFT_PREFIX + newer.id)).not.toBeNull();
  });
});

/**
 * Two tabs on one console share one localStorage. Each writes only what it changed, and hears
 * what the other wrote; which flow is on screen and which node is picked stay each tab's own.
 */
describe('two tabs', () => {
  it('leave each other\'s drafts in storage when one picks a node or shows a flow', async () => {
    const other = await reopened();
    const watch = emptyFlow('Watch');
    useFlowDraftStore.getState().put(watch);

    other.getState().select('n1');
    other.getState().show('somewhere');

    const later = await reopened();
    expect(later.getState().drafts[watch.id]?.name).toBe('Watch');
  });

  it('hear what the other did to a flow\'s draft, and keep their own drafts and their own place', async () => {
    const other = await reopened();
    const mine = emptyFlow('Mine');
    other.getState().put(mine);
    other.getState().show(mine.id);
    other.getState().select('n1');

    const theirs = emptyFlow('Theirs');
    let before = held();
    useFlowDraftStore.getState().put(theirs);
    useFlowDraftStore.getState().show(theirs.id);
    announce(before);

    expect(other.getState().drafts[theirs.id]?.name).toBe('Theirs');
    expect(other.getState().drafts[mine.id]?.name).toBe('Mine');
    expect(other.getState().current).toBe(mine.id);
    expect(other.getState().selected).toBe('n1');

    before = held();
    useFlowDraftStore.getState().discard(theirs.id);
    announce(before);

    expect(other.getState().drafts[theirs.id]).toBeUndefined();
    expect(other.getState().drafts[mine.id]?.name).toBe('Mine');
  });
});
