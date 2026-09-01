import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { useAppearanceStore } from '../../stores/appearanceStore';
import { NOT_READY } from '../alerts/alertSound';
import { AppearancePanel } from './AppearancePanel';
import { startApplyingAppearance } from './applyAppearance';
import { SANS, SIZE } from './fonts';

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
  // It used to stand at the foot of the alerts panel, among alerting's other controls. But it is
  // not a control about alerting: every rule decides for itself whether it asks for a tone, and
  // this decides whether this machine, in this browser, is willing to make one — which is the
  // same kind of fact as the face the console is set in and the health line being on.
  it('holds the sound switch, which the alerts panel no longer does', () => {
    const { stop } = renderPanel();

    expect(screen.getByRole('button', { name: 'Sound off' })).toBeInTheDocument();
    stop();
  });

  // On or off, and nothing in between. The switch used to carry a third label for 'on, but the
  // browser has not let a sound through yet' — which is a fact about the browser rather than a
  // position the switch is in. It is said under the switch instead, where it does not pretend to
  // be a state the reader chose.
  it('is on or off, and says underneath when the browser has not let a sound through', () => {
    useAppearanceStore.setState({ alertSound: true });

    const { stop } = renderPanel();

    expect(screen.getByRole('button', { name: 'Sound on' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sound waiting' })).not.toBeInTheDocument();
    expect(screen.getByText(NOT_READY)).toBeInTheDocument();
    stop();
  });

  // Everything about the chart moved to its own panel, so this one holds what is left: the face
  // the console is set in, its size, and the mark it wears.
  it("leaves the chart's own settings to the chart panel", () => {
    const { stop } = renderPanel();

    expect(screen.queryByLabelText('Detail')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Range')).not.toBeInTheDocument();
    stop();
  });

  it('re-fonts the document when the sans choice changes', async () => {
    const { stop } = renderPanel();

    await userEvent.selectOptions(screen.getByLabelText('Font'), 'system');

    expect(root().style.getPropertyValue('--sans')).toBe(SANS.system.stack);
    stop();
  });

  // One face to choose, not two. The monospace face is the console's own — the log, the topics
  // and every payload are set in it — and offering it as a preference asked the reader to make a
  // decision about the product's handwriting.
  it('offers one font to choose, and keeps the monospace face to itself', () => {
    const { stop } = renderPanel();

    expect(screen.getByLabelText('Font')).toBeInTheDocument();
    expect(screen.queryByLabelText('Mono font')).not.toBeInTheDocument();
    stop();
  });

  it('writes the slider value to the root font size and shows it', async () => {
    const { stop } = renderPanel();
    const slider = screen.getByRole('slider', { name: 'Base size' });

    // jsdom doesn't support range-input arrow-key stepping; fire the change directly.
    fireEvent.change(slider, { target: { value: '14' } });

    expect(root().style.fontSize).toBe('14px');
    expect(screen.getByText('14px')).toBeInTheDocument();
    expect(slider).toHaveAttribute('aria-valuetext', '14 pixels');
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

    await userEvent.selectOptions(screen.getByLabelText('Font'), 'system');
    await userEvent.click(screen.getByRole('button', { name: 'Restore defaults' }));

    expect(root().style.getPropertyValue('--sans')).toBe(SANS.inter.stack);
    expect(root().style.fontSize).toBe('13px');
    expect(screen.getByLabelText('Font')).toHaveValue('inter');
    stop();
  });

  // Already safe: synchronous store writes, no network call, so no guard needed here.
  it('stays consistent when Restore defaults is hammered with no waits', async () => {
    const { stop } = renderPanel();
    await userEvent.selectOptions(screen.getByLabelText('Font'), 'system');
    const restore = screen.getByRole('button', { name: 'Restore defaults' });

    fireEvent.click(restore);
    fireEvent.click(restore);
    fireEvent.click(restore);

    expect(root().style.getPropertyValue('--sans')).toBe(SANS.inter.stack);
    expect(screen.getByLabelText('Font')).toHaveValue('inter');
    stop();
  });
});
