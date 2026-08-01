import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { useAppearanceStore } from '../../stores/appearanceStore';
import { AppearancePanel } from './AppearancePanel';
import { startApplyingAppearance } from './applyAppearance';
import { MONO, SANS } from './fonts';

const root = () => document.documentElement;

beforeEach(() => {
  localStorage.clear();
  useAppearanceStore.getState().reset();
  root().removeAttribute('style');
});

// The panel only writes to the store; the subscription is what reaches the document, so
// these tests start it exactly as main.tsx does.
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

    // jsdom does not implement the native arrow-key stepping behaviour of a range
    // input (userEvent.keyboard leaves the value untouched), so the value change a
    // real key press would produce is delivered directly via a change event instead.
    fireEvent.change(slider, { target: { value: '17' } });

    expect(root().style.fontSize).toBe('17px');
    expect(screen.getByText('17px')).toBeInTheDocument();
    expect(slider).toHaveAttribute('aria-valuetext', '17 pixels');
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
});
