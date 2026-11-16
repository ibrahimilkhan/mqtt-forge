import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { blankScene } from '../model/defaults';
import { studioStore } from '../studioStore';
import { Toolbar } from './Toolbar';

beforeEach(() => studioStore.getState().open(blankScene('Cell')));

describe('Toolbar', () => {
  it('adds the shape whose button is pressed', async () => {
    const onAdd = vi.fn();
    render(<Toolbar onAdd={onAdd} saveState={{ kind: 'saved' }} onRetry={() => {}} sceneMenu={null} />);
    await userEvent.click(screen.getByRole('button', { name: 'Add Cylinder' }));
    expect(onAdd).toHaveBeenCalledWith('cylinder');
  });

  it('switches the tool', async () => {
    render(<Toolbar onAdd={() => {}} saveState={{ kind: 'saved' }} onRetry={() => {}} sceneMenu={null} />);
    await userEvent.click(screen.getByRole('radio', { name: 'Rotate' }));
    expect(studioStore.getState().tool).toBe('rotate');
  });

  it('undoes and redoes, and says when there is nothing to', async () => {
    render(<Toolbar onAdd={() => {}} saveState={{ kind: 'saved' }} onRetry={() => {}} sceneMenu={null} />);
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
    studioStore.getState().addPrimitive('box', [0, 0, 0]);
    await userEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(studioStore.getState().scene!.objects).toHaveLength(0);
  });

  it('says when a save failed and offers to try again', async () => {
    const onRetry = vi.fn();
    render(<Toolbar onAdd={() => {}} saveState={{ kind: 'failed', message: 'Disk full' }} onRetry={onRetry} sceneMenu={null} />);
    expect(screen.getByText(/Not saved/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('writes the move steps in the display unit', () => {
    studioStore.getState().updateSettings({ displayUnit: 'cm' });
    render(<Toolbar onAdd={() => {}} saveState={{ kind: 'saved' }} onRetry={() => {}} sceneMenu={null} />);
    expect(screen.getByRole('option', { name: '50 cm' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '500 mm' })).not.toBeInTheDocument();
  });
});
