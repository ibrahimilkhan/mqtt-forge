import { beforeEach, describe, expect, it } from 'vitest';
import { useComposeStore } from './composeStore';

beforeEach(() => useComposeStore.setState({ draft: null, qos: 0, retain: false }));

describe('composeStore', () => {
  it('starts with nothing loaded, so the form keeps its own defaults', () => {
    expect(useComposeStore.getState().draft).toBeNull();
  });

  it('carries where and what across', () => {
    useComposeStore.getState().load({ topic: 'lab/oven', payload: '180' });

    expect(useComposeStore.getState().draft).toMatchObject({ topic: 'lab/oven', payload: '180' });
  });

  // How a message goes out is the reader's answer, and a draft is somebody else's message: a tree
  // node's newest arrival, a log row's delivered copy. Loading one used to write both flags.
  it('leaves the QoS and the retain flag alone, however many drafts are loaded over it', () => {
    useComposeStore.getState().setQos(2);
    useComposeStore.getState().setRetain(true);

    useComposeStore.getState().load({ topic: 'lab/oven', payload: '180' });
    useComposeStore.getState().load({ topic: 'lab' });

    expect(useComposeStore.getState().qos).toBe(2);
    expect(useComposeStore.getState().retain).toBe(true);
  });

  // Clicking the same topic twice has to reload the form, so the two drafts must differ.
  it('marks each load as a fresh one even when the values repeat', () => {
    const same = { topic: 'lab/oven', payload: '180' };

    useComposeStore.getState().load(same);
    const first = useComposeStore.getState().draft!.serial;
    useComposeStore.getState().load(same);

    expect(useComposeStore.getState().draft!.serial).not.toBe(first);
  });
});
