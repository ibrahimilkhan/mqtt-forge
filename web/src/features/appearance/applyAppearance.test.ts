import { beforeEach, describe, expect, it } from 'vitest';
import { useAppearanceStore } from '../../stores/appearanceStore';
import { MONO, SANS } from './fonts';
import { startApplyingAppearance } from './applyAppearance';

const root = () => document.documentElement;

beforeEach(() => {
  localStorage.clear();
  useAppearanceStore.getState().reset();
  root().removeAttribute('style');
});

describe('startApplyingAppearance', () => {
  it('writes the current choices to the document root straight away', () => {
    const stop = startApplyingAppearance();

    expect(root().style.getPropertyValue('--sans')).toBe(SANS.inter.stack);
    expect(root().style.getPropertyValue('--mono')).toBe(MONO.jetbrains.stack);
    expect(root().style.fontSize).toBe('13px');

    stop();
  });

  it('rewrites them whenever a choice changes', () => {
    const stop = startApplyingAppearance();

    useAppearanceStore.getState().setSans('system');
    useAppearanceStore.getState().setSize(19);

    expect(root().style.getPropertyValue('--sans')).toBe(SANS.system.stack);
    expect(root().style.fontSize).toBe('19px');

    stop();
  });

  it('stops writing once the subscription is dropped', () => {
    const stop = startApplyingAppearance();
    stop();

    useAppearanceStore.getState().setSize(20);

    expect(root().style.fontSize).toBe('13px');
  });
});
