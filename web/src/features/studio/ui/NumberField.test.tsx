import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { NumberField } from './NumberField';

describe('NumberField', () => {
  it('commits a worked-out expression on Enter', async () => {
    const onCommit = vi.fn();
    render(<NumberField label="X" value={10} onCommit={onCommit} length unit="mm" />);
    const field = screen.getByRole('textbox', { name: 'X' });

    await userEvent.clear(field);
    await userEvent.type(field, '1cm+2{Enter}');

    expect(onCommit).toHaveBeenCalledWith(12);
  });

  it('goes back to the value when it cannot read what was typed', async () => {
    const onCommit = vi.fn();
    render(<NumberField label="X" value={10} onCommit={onCommit} />);
    const field = screen.getByRole('textbox', { name: 'X' });

    await userEvent.clear(field);
    await userEvent.type(field, 'abc{Enter}');

    expect(onCommit).not.toHaveBeenCalled();
    expect(field).toHaveValue('10');
  });

  it('steps with the arrow keys, ten at a time with Shift', async () => {
    const onCommit = vi.fn();
    render(<NumberField label="X" value={10} onCommit={onCommit} step={1} />);
    const field = screen.getByRole('textbox', { name: 'X' });

    await userEvent.type(field, '{ArrowUp}');
    expect(onCommit).toHaveBeenLastCalledWith(11);
    await userEvent.type(field, '{Shift>}{ArrowDown}{/Shift}');
    expect(onCommit).toHaveBeenLastCalledWith(0);
  });

  it('rejects a value via accepts, going back to the field to what is there', async () => {
    const onCommit = vi.fn();
    render(<NumberField label="X" value={1} onCommit={onCommit} accepts={(v) => v > 0} />);
    const field = screen.getByRole('textbox', { name: 'X' });

    await userEvent.clear(field);
    await userEvent.type(field, '-5{Enter}');

    expect(onCommit).not.toHaveBeenCalled();
    expect(field).toHaveValue('1');
  });

  it('rejects a stepped value via accepts', async () => {
    const onCommit = vi.fn();
    render(<NumberField label="X" value={1} onCommit={onCommit} accepts={(v) => v > 0} step={1} />);
    const field = screen.getByRole('textbox', { name: 'X' });

    // Try to go down below the minimum
    await userEvent.type(field, '{ArrowDown}{ArrowDown}');

    expect(onCommit).not.toHaveBeenCalled();
    expect(field).toHaveValue('1');
  });
});
