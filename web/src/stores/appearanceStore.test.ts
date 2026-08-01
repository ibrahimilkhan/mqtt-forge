import { beforeEach, describe, expect, it } from 'vitest';
import { sanitize, STORAGE_KEY, useAppearanceStore } from './appearanceStore';

const DEFAULTS = { sans: 'inter', mono: 'jetbrains', size: 15 };

beforeEach(() => {
  // reset() itself persists the defaults back through zustand's `persist`, so it must run
  // before the clear below — clearing first would just be undone by that write, and the
  // next test would observe a localStorage entry it never asked for.
  useAppearanceStore.getState().reset();
  localStorage.clear();
});

describe('sanitize', () => {
  it('falls back to the defaults when an id is not in the catalogue', () => {
    expect(sanitize({ sans: 'comic', mono: 'nope', size: 15 })).toEqual(DEFAULTS);
  });

  it('clamps a size that sits outside the allowed range', () => {
    expect(sanitize({ ...DEFAULTS, size: 99 }).size).toBe(20);
    expect(sanitize({ ...DEFAULTS, size: 2 }).size).toBe(12);
  });

  it('rounds a fractional size to a whole pixel', () => {
    expect(sanitize({ ...DEFAULTS, size: 16.4 }).size).toBe(16);
  });

  it('falls back to the default size when the value is not a number', () => {
    expect(sanitize({ ...DEFAULTS, size: '16' }).size).toBe(15);
    expect(sanitize({ ...DEFAULTS, size: Number.NaN }).size).toBe(15);
  });

  it('returns the defaults for anything that is not a plain object', () => {
    for (const raw of [null, undefined, 3, 'x', []]) {
      expect(sanitize(raw)).toEqual(DEFAULTS);
    }
  });
});

describe('persistence', () => {
  it('writes only the three choices under the storage key', () => {
    useAppearanceStore.getState().setSize(17);

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).state).toEqual({
      sans: 'inter',
      mono: 'jetbrains',
      size: 17,
    });
  });

  it('restores a stored choice on rehydration', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ state: { sans: 'system', mono: 'system', size: 18 }, version: 1 }),
    );

    await useAppearanceStore.persist.rehydrate();

    const { sans, mono, size, setSans } = useAppearanceStore.getState();
    expect({ sans, mono, size }).toEqual({ sans: 'system', mono: 'system', size: 18 });
    expect(typeof setSans).toBe('function'); // The replace-on-hydrate must not drop the actions.
  });

  it('rehydrates a corrupt stored value to the defaults rather than propagating it', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ state: { sans: 'comic', mono: 'nope', size: 'not-a-number' }, version: 1 }),
    );

    await useAppearanceStore.persist.rehydrate();

    const { sans, mono, size } = useAppearanceStore.getState();
    expect({ sans, mono, size }).toEqual(DEFAULTS);
  });

  it('does not throw when the storage write fails, and the choice still applies to this tab', () => {
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    };

    try {
      expect(() => useAppearanceStore.getState().setSize(18)).not.toThrow();
      expect(useAppearanceStore.getState().size).toBe(18);
    } finally {
      Storage.prototype.setItem = originalSetItem;
    }
  });
});
