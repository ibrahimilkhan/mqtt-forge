import { beforeEach, describe, expect, it } from 'vitest';
import { useComposeStore } from './composeStore';

beforeEach(() => useComposeStore.setState({ draft: null }));

describe('composeStore', () => {
  it('starts with nothing loaded, so the form keeps its own defaults', () => {
    expect(useComposeStore.getState().draft).toBeNull();
  });

  it('carries the topic and the message settings across', () => {
    useComposeStore.getState().load({ topic: 'lab/oven', payload: '180', qos: 2, retain: true });

    expect(useComposeStore.getState().draft).toMatchObject({
      topic: 'lab/oven',
      payload: '180',
      qos: 2,
      retain: true,
    });
  });

  // Clicking the same topic twice has to reload the form, so the two drafts must differ.
  it('marks each load as a fresh one even when the values repeat', () => {
    const same = { topic: 'lab/oven', payload: '180', qos: 0, retain: false };

    useComposeStore.getState().load(same);
    const first = useComposeStore.getState().draft!.serial;
    useComposeStore.getState().load(same);

    expect(useComposeStore.getState().draft!.serial).not.toBe(first);
  });
});
