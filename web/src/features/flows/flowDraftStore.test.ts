import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyFlow, fingerprint } from './flowDocument';
import { createFlowDraftStore, DRAFT_PREFIX, useFlowDraftStore } from './flowDraftStore';

/** Where every draft was kept together before each had a key of its own. */
const OLD_KEY = 'mqttforge.flows.drafts';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  useFlowDraftStore.setState({ drafts: {}, bases: {}, current: null, selected: null, refusals: {}, unkept: false });
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

  it('lets the refusals of some flows lapse, and keeps the drafts and the other refusals', () => {
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

  // The server sends no version of a flow, so a draft remembers a fingerprint of the copy it was
  // started from, and keeps it however the draft changes after.
  it('remembers the copy on the server a draft was started from', () => {
    const deployed = emptyFlow('Boiler watch');

    useFlowDraftStore.getState().edit(deployed, (flow) => ({ ...flow, name: 'Boiler house' }));
    useFlowDraftStore.getState().edit({ ...deployed, name: 'Another copy' }, (flow) => ({ ...flow, enabled: false }));

    expect(useFlowDraftStore.getState().bases[deployed.id]).toBe(fingerprint(deployed));
  });

  it('starts a flow made here from no copy on the server', () => {
    const flow = emptyFlow('Made here');

    useFlowDraftStore.getState().put(flow);

    expect(useFlowDraftStore.getState().bases[flow.id]).toBeNull();
  });

  // A draft that holds nothing of the reader's goes, and the reader stays where they were: the same
  // flow on screen, the same node in the inspector.
  it('settles drafts that hold nothing, and leaves the flow on screen and the pick alone', () => {
    const back = emptyFlow('Back');
    const other = emptyFlow('Other');
    const store = useFlowDraftStore.getState();
    store.edit(back, (flow) => ({ ...flow, enabled: false }));
    store.put(other);
    store.show(back.id);
    store.select('n1');
    store.refuse(back.id, { flow: ['Name the flow.'] });

    useFlowDraftStore.getState().settle([back.id]);

    const after = useFlowDraftStore.getState();
    expect(Object.keys(after.drafts)).toEqual([other.id]);
    expect(after.refusals).toEqual({});
    expect(Object.keys(after.bases)).toEqual([other.id]);
    expect(after.current).toBe(back.id);
    expect(after.selected).toBe('n1');
    expect(localStorage.getItem(DRAFT_PREFIX + back.id)).toBeNull();
  });

  it('counts a draft as made on another copy once the reader keeps it over that copy', () => {
    const deployed = emptyFlow('Kept over');
    useFlowDraftStore.getState().edit(deployed, (flow) => ({ ...flow, enabled: false }));

    useFlowDraftStore.getState().rebase(deployed.id, 'k3y');

    expect(useFlowDraftStore.getState().bases[deployed.id]).toBe('k3y');
    expect(JSON.parse(localStorage.getItem(DRAFT_PREFIX + deployed.id)!).base).toBe('k3y');
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
    expect(JSON.parse(localStorage.getItem(DRAFT_PREFIX + two.id)!)).toEqual({ version: 1, flow: two, base: null });
  });

  it('keeps with each draft the copy it was started from, through a reload', async () => {
    const deployed = emptyFlow('Deployed');
    const made = emptyFlow('Made here');
    useFlowDraftStore.getState().edit(deployed, (flow) => ({ ...flow, enabled: false }));
    useFlowDraftStore.getState().put(made);

    const reloaded = await reopened();

    expect(JSON.parse(localStorage.getItem(DRAFT_PREFIX + deployed.id)!)).toEqual({
      version: 1,
      flow: { ...deployed, enabled: false },
      base: fingerprint(deployed),
    });
    expect(reloaded.getState().bases).toEqual({ [deployed.id]: fingerprint(deployed), [made.id]: null });
  });

  // A draft kept before drafts remembered where they started has no start to read, and says so by
  // having none: the page places it on the server's copy when it first reads one.
  it('reads no start for a draft kept before drafts remembered one', async () => {
    const flow = emptyFlow('From before');
    localStorage.setItem(DRAFT_PREFIX + flow.id, JSON.stringify({ version: 1, flow }));

    const opened = await reopened();

    expect(opened.getState().drafts).toEqual({ [flow.id]: flow });
    expect(flow.id in opened.getState().bases).toBe(false);
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

/** Storage that takes nothing more, the way a full one or a blocked one answers every write. */
const fullStorage = () =>
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
  });

/**
 * Storage full, or site data blocked: the drafts live on this page and no longer, and what a
 * reload brings back is older than what is on screen, or nothing.
 */
describe('a browser that will not keep the drafts', () => {
  it('says so once, however many drafts it refuses, and keeps them on the page', () => {
    const full = fullStorage();
    // What the page reads, as it reads it: each value the store holds, once it holds it.
    const seen: boolean[] = [];
    const stop = useFlowDraftStore.subscribe((state) => {
      if (state.unkept !== (seen.at(-1) ?? false)) seen.push(state.unkept);
    });
    const flow = emptyFlow('Too much');

    useFlowDraftStore.getState().edit(flow, (one) => ({ ...one, name: 'Too much 1' }));
    useFlowDraftStore.getState().edit(flow, (one) => ({ ...one, name: 'Too much 12' }));
    useFlowDraftStore.getState().put(emptyFlow('And more'));
    stop();
    full.mockRestore();

    expect(seen).toEqual([true]);
    expect(useFlowDraftStore.getState().drafts[flow.id].name).toBe('Too much 12');
  });

  // The drafts kept all together before move to keys of their own when the page opens, and a
  // storage too full for them keeps them for this visit only.
  it('says so when the drafts kept from before cannot be moved', async () => {
    const flow = emptyFlow('From before');
    localStorage.setItem(OLD_KEY, JSON.stringify({ state: { drafts: { [flow.id]: flow }, current: null }, version: 0 }));
    const full = fullStorage();

    const opened = await reopened();
    full.mockRestore();

    expect(opened.getState().drafts).toEqual({ [flow.id]: flow });
    expect(opened.getState().unkept).toBe(true);
  });

  it('says nothing while the drafts are kept', async () => {
    useFlowDraftStore.getState().put(emptyFlow('Kept'));

    expect(useFlowDraftStore.getState().unkept).toBe(false);
    expect((await reopened()).getState().unkept).toBe(false);
  });
});

/**
 * Two tabs on one console share one localStorage. Each writes only what it changed, and hears
 * what the other wrote; which flow is on screen and which node is picked stay each tab's own.
 * The other tab is a second store made over the same storage, as a second page would make it.
 */
describe('two tabs', () => {
  it('leave each other\'s drafts in storage when one picks a node or shows a flow', async () => {
    const other = createFlowDraftStore();
    const watch = emptyFlow('Watch');
    useFlowDraftStore.getState().put(watch);

    other.getState().select('n1');
    other.getState().show('somewhere');

    const later = await reopened();
    expect(later.getState().drafts[watch.id]?.name).toBe('Watch');
  });

  it('hear what the other did to a flow\'s draft, and keep their own drafts and their own place', () => {
    const other = createFlowDraftStore();
    const mine = emptyFlow('Mine');
    other.getState().put(mine);
    other.getState().show(mine.id);
    other.getState().select('n1');

    const theirs = emptyFlow('Theirs');
    let before = held();
    useFlowDraftStore.getState().edit(theirs, (flow) => ({ ...flow, enabled: false }));
    useFlowDraftStore.getState().show(theirs.id);
    announce(before);

    expect(other.getState().drafts[theirs.id]?.name).toBe('Theirs');
    expect(other.getState().bases[theirs.id]).toBe(fingerprint(theirs));
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
