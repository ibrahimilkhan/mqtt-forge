import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { blankScene } from '../model/defaults';
import { studioStore } from '../studioStore';
import { Outliner } from './Outliner';

beforeEach(() => {
  studioStore.getState().open(blankScene('Cell'));
  studioStore.getState().addPrimitive('box', [0, 0, 0]);
  studioStore.getState().addPrimitive('sphere', [0, 0, 0]);
  studioStore.getState().select([]);
});

describe('Outliner', () => {
  it('lists the objects and selects the one clicked', async () => {
    render(<Outliner />);
    await userEvent.click(screen.getByRole('button', { name: 'Sphere 1' }));
    expect(studioStore.getState().selection).toEqual([studioStore.getState().scene!.objects[1].id]);
  });

  it('narrows the list to what the search matches', async () => {
    render(<Outliner />);
    await userEvent.type(screen.getByRole('searchbox', { name: 'Find an object' }), 'sph');
    expect(screen.queryByRole('button', { name: 'Box 1' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sphere 1' })).toBeInTheDocument();
  });

  it('hides and shows an object', async () => {
    render(<Outliner />);
    await userEvent.click(screen.getByRole('button', { name: 'Hide Box 1' }));
    expect(studioStore.getState().scene!.objects[0].hidden).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Show Box 1' }));
    expect(studioStore.getState().scene!.objects[0].hidden).toBe(false);
  });
});
