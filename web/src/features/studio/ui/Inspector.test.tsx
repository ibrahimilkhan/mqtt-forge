import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { blankScene } from '../model/defaults';
import { studioStore } from '../studioStore';
import { Inspector } from './Inspector';

beforeEach(() => {
  studioStore.getState().open(blankScene('Cell'));
  studioStore.getState().updateSettings({ displayUnit: 'mm' });
  studioStore.getState().addPrimitive('box', [0, 0, 0]);
});

const box = () => studioStore.getState().scene!.objects[0];

describe('Inspector', () => {
  it('says to pick something when nothing is selected', () => {
    studioStore.getState().select([]);
    render(<Inspector />);
    expect(screen.getByText(/Select an object/)).toBeInTheDocument();
  });

  it('moves the object by a length typed in the display unit', async () => {
    render(<Inspector />);
    const x = screen.getByRole('textbox', { name: 'Position X' });
    await userEvent.clear(x);
    await userEvent.type(x, '250{Enter}');
    expect(box().position[0]).toBeCloseTo(0.25);
  });

  it('turns the object by an angle typed in degrees', async () => {
    render(<Inspector />);
    const y = screen.getByRole('textbox', { name: 'Rotation Y' });
    await userEvent.clear(y);
    await userEvent.type(y, '90{Enter}');
    expect(box().euler[1]).toBeCloseTo(Math.PI / 2);
  });

  it('renames the object', async () => {
    render(<Inspector />);
    const name = screen.getByRole('textbox', { name: 'Name' });
    await userEvent.clear(name);
    await userEvent.type(name, 'Base plate{Enter}');
    expect(box().name).toBe('Base plate');
  });

  it('applies a material preset', async () => {
    render(<Inspector />);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Material' }), 'steel');
    expect(box().mat).toEqual({ metal: 1, rough: 0.35 });
  });

  it('says a model is a placeholder until model loading arrives', () => {
    const id = box().id;
    studioStore.getState().updateObject(id, { type: 'model', model: { key: 'k.glb', ext: '.glb' } });
    render(<Inspector />);
    expect(screen.getByText(/placeholder/i)).toBeInTheDocument();
  });

  it('rejects a zero scale, staying at the current value', async () => {
    render(<Inspector />);
    const scaleX = screen.getByRole('textbox', { name: 'Scale X' });

    await userEvent.clear(scaleX);
    await userEvent.type(scaleX, '0{Enter}');

    expect(box().scaling[0]).toBe(1);
    expect(scaleX).toHaveValue('1');
  });
});
