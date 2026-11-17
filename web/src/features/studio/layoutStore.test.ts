import { afterEach, describe, expect, it, vi } from 'vitest';
import { LAYOUT_DEFAULTS, LAYOUT_KEY, useStudioLayout } from './layoutStore';

afterEach(() => {
  vi.restoreAllMocks();
  useStudioLayout.setState(LAYOUT_DEFAULTS);
});

describe('studio layout', () => {
  it('opens both floating panels by default', () => {
    expect(LAYOUT_DEFAULTS).toEqual({ treeOpen: true, inspectorOpen: true });
  });

  it('keeps which panels are open in local storage', () => {
    useStudioLayout.getState().setTreeOpen(false);
    expect(JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}').state).toEqual({ treeOpen: false, inspectorOpen: true });
  });

  it('reads a stored choice back, and a hand-edited value falls back to the default', async () => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ state: { treeOpen: false, inspectorOpen: 'yes' }, version: 1 }));
    await useStudioLayout.persist.rehydrate();
    expect(useStudioLayout.getState()).toMatchObject({ treeOpen: false, inspectorOpen: true });
  });

  it('still switches when storage refuses to be read or written', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });

    await useStudioLayout.persist.rehydrate();
    useStudioLayout.getState().setInspectorOpen(false);

    expect(useStudioLayout.getState().inspectorOpen).toBe(false);
    expect(warn).toHaveBeenCalled();
  });
});
