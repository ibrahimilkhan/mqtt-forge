import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LAYOUT_DEFAULTS, useStudioLayout } from '../layoutStore';
import { blankScene } from '../model/defaults';
import { studioStore } from '../studioStore';
import { Toolbar, type SaveState } from './Toolbar';

beforeEach(() => {
  studioStore.getState().open(blankScene('Cell'));
  studioStore.getState().setTool('move');
  useStudioLayout.setState(LAYOUT_DEFAULTS);
});

const draw = ({ onAdd = () => {}, onFocus = () => {}, saveState = { kind: 'saved' } as SaveState, onRetry = () => {} } = {}) =>
  render(<Toolbar onAdd={onAdd} onFocus={onFocus} saveState={saveState} onRetry={onRetry} sceneMenu={null} />);

describe('Toolbar', () => {
  it('adds the shape picked from the Add menu, and the menu shuts behind it', async () => {
    const onAdd = vi.fn();
    draw({ onAdd });
    expect(screen.queryByRole('menuitem', { name: 'Cylinder' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Add a shape' }));
    expect(screen.getAllByRole('menuitem')).toHaveLength(8);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Cylinder' }));

    expect(onAdd).toHaveBeenCalledWith('cylinder');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('switches the tool from a radio group of marks named with their keys', async () => {
    draw();
    const group = screen.getByRole('radiogroup', { name: 'Tool' });
    expect(screen.getByRole('radio', { name: 'Move (W)' })).toHaveAttribute('aria-checked', 'true');
    expect(group).toContainElement(screen.getByRole('radio', { name: 'Rotate (E)' }));

    await userEvent.click(screen.getByRole('radio', { name: 'Rotate (E)' }));

    expect(studioStore.getState().tool).toBe('rotate');
    expect(screen.getByRole('radio', { name: 'Rotate (E)' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Move (W)' })).toHaveAttribute('aria-checked', 'false');
  });

  it('walks the tools with the arrow keys, and only the chosen one is a Tab stop', async () => {
    draw();
    screen.getByRole('radio', { name: 'Move (W)' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(studioStore.getState().tool).toBe('rotate');
    expect(screen.getByRole('radio', { name: 'Rotate (E)' })).toHaveFocus();
    expect(screen.getAllByRole('radio').filter((r) => r.tabIndex === 0)).toHaveLength(1);
  });

  it('swaps the axes between the world and the object, and its name says which is in use', async () => {
    draw();
    await userEvent.click(screen.getByRole('button', { name: 'Axes: World' }));
    expect(studioStore.getState().orientation).toBe('local');
    expect(screen.getByRole('button', { name: 'Axes: Local' })).toBeInTheDocument();
  });

  it('switches snapping on and off, and says which', async () => {
    draw();
    const snap = screen.getByRole('button', { name: 'Snap' });
    const was = studioStore.getState().scene!.settings.snap;
    expect(snap).toHaveAttribute('aria-pressed', String(was));

    await userEvent.click(snap);

    expect(studioStore.getState().scene!.settings.snap).toBe(!was);
    expect(snap).toHaveAttribute('aria-pressed', String(!was));
  });

  it('sets the steps from the Steps menu, writing the move steps in the display unit', async () => {
    studioStore.getState().updateSettings({ displayUnit: 'cm' });
    draw();
    await userEvent.click(screen.getByRole('button', { name: 'Snap steps' }));

    const steps = screen.getByRole('dialog', { name: 'Snap steps' });
    expect(screen.getByRole('option', { name: '50 cm' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '500 mm' })).not.toBeInTheDocument();

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Turn step' }), '45');
    expect(studioStore.getState().scene!.settings.rotateStep).toBe(45);
    // A field changed is not a choice made: the popup stays for the next one.
    expect(steps).toBeInTheDocument();
  });

  it('undoes and redoes, and says when there is nothing to', async () => {
    draw();
    expect(screen.getByRole('button', { name: 'Undo (Ctrl+Z)' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Redo (Ctrl+Y)' })).toBeDisabled();
    studioStore.getState().addPrimitive('box', [0, 0, 0]);
    await userEvent.click(await screen.findByRole('button', { name: 'Undo (Ctrl+Z)' }));
    expect(studioStore.getState().scene!.objects).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Redo (Ctrl+Y)' }));
    expect(studioStore.getState().scene!.objects).toHaveLength(1);
  });

  it('opens and shuts the floating panels, saying which are open', async () => {
    draw();
    const tree = screen.getByRole('button', { name: 'Object tree' });
    const inspector = screen.getByRole('button', { name: 'Inspector' });
    expect(tree).toHaveAttribute('aria-pressed', 'true');
    expect(inspector).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(tree);
    await userEvent.click(inspector);

    expect(useStudioLayout.getState()).toMatchObject({ treeOpen: false, inspectorOpen: false });
    expect(tree).toHaveAttribute('aria-pressed', 'false');
    expect(inspector).toHaveAttribute('aria-pressed', 'false');
  });

  it('focuses the selection only when there is one', async () => {
    const onFocus = vi.fn();
    draw({ onFocus });
    expect(screen.getByRole('button', { name: 'Focus selection (F)' })).toBeDisabled();
    studioStore.getState().addPrimitive('box', [0, 0, 0]);
    await userEvent.click(await screen.findByRole('button', { name: 'Focus selection (F)' }));
    expect(onFocus).toHaveBeenCalled();
  });

  it('says when a save failed and offers to try again', async () => {
    const onRetry = vi.fn();
    draw({ saveState: { kind: 'failed', message: 'Disk full' }, onRetry });
    expect(screen.getByRole('status')).toHaveTextContent('Not saved');
    expect(screen.getByText('Not saved')).toHaveAttribute('title', 'Disk full');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('says when the scene is saved and when it is being saved', () => {
    const { rerender } = draw();
    expect(screen.getByRole('status')).toHaveTextContent('Saved');
    rerender(<Toolbar onAdd={() => {}} onFocus={() => {}} saveState={{ kind: 'saving' }} onRetry={() => {}} sceneMenu={null} />);
    expect(screen.getByRole('status')).toHaveTextContent('Saving…');
  });
});
