import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { useAppearanceStore } from '../../stores/appearanceStore';
import { AppearancePanel } from './AppearancePanel';
import { startApplyingAppearance } from './applyAppearance';
import { MONO, SANS, SIZE } from './fonts';

const root = () => document.documentElement;

beforeEach(() => {
  localStorage.clear();
  useAppearanceStore.getState().reset();
  root().removeAttribute('style');
});

// Panel only writes to the store; start the subscription too, as main.tsx does.
function renderPanel() {
  const stop = startApplyingAppearance();
  const result = render(<AppearancePanel onClose={() => {}} />);
  return { ...result, stop };
}

describe('AppearancePanel', () => {
  it('re-fonts the document when the sans choice changes', async () => {
    const { stop } = renderPanel();

    await userEvent.selectOptions(screen.getByLabelText('Sans font'), 'system');

    expect(root().style.getPropertyValue('--sans')).toBe(SANS.system.stack);
    stop();
  });

  it('re-fonts the document when the mono choice changes', async () => {
    const { stop } = renderPanel();

    await userEvent.selectOptions(screen.getByLabelText('Mono font'), 'system');

    expect(root().style.getPropertyValue('--mono')).toBe(MONO.system.stack);
    stop();
  });

  it('writes the slider value to the root font size and shows it', async () => {
    const { stop } = renderPanel();
    const slider = screen.getByRole('slider', { name: 'Base size' });

    // jsdom doesn't support range-input arrow-key stepping; fire the change directly.
    fireEvent.change(slider, { target: { value: '17' } });

    expect(root().style.fontSize).toBe('17px');
    expect(screen.getByText('17px')).toBeInTheDocument();
    expect(slider).toHaveAttribute('aria-valuetext', '17 pixels');
    stop();
  });

  it('takes its bounds from SIZE rather than a hardcoded range', () => {
    const { stop } = renderPanel();
    const slider = screen.getByRole('slider', { name: 'Base size' });

    expect(slider).toHaveAttribute('min', String(SIZE.min));
    expect(slider).toHaveAttribute('max', String(SIZE.max));
    expect(slider).toHaveAttribute('step', String(SIZE.step));
    stop();
  });

  it('restores all three defaults at once', async () => {
    const { stop } = renderPanel();

    await userEvent.selectOptions(screen.getByLabelText('Sans font'), 'system');
    await userEvent.click(screen.getByRole('button', { name: 'Restore defaults' }));

    expect(root().style.getPropertyValue('--sans')).toBe(SANS.inter.stack);
    expect(root().style.fontSize).toBe('15px');
    expect(screen.getByLabelText('Sans font')).toHaveValue('inter');
    stop();
  });

  // Already safe: synchronous store writes, no network call, so no guard needed here.
  it('stays consistent when Restore defaults is hammered with no waits', async () => {
    const { stop } = renderPanel();
    await userEvent.selectOptions(screen.getByLabelText('Sans font'), 'system');
    const restore = screen.getByRole('button', { name: 'Restore defaults' });

    fireEvent.click(restore);
    fireEvent.click(restore);
    fireEvent.click(restore);

    expect(root().style.getPropertyValue('--sans')).toBe(SANS.inter.stack);
    expect(screen.getByLabelText('Sans font')).toHaveValue('inter');
    stop();
  });
});
