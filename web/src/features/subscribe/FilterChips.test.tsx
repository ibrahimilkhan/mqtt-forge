import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSelectionStore } from '../../stores/selectionStore';
import { FilterChips } from './FilterChips';

const filters = ['sensors/#', 'devices/+/state'];

beforeEach(() => useSelectionStore.getState().clear());

describe('FilterChips', () => {
  it('focuses the wire log on the filter that was clicked', async () => {
    render(<FilterChips filters={filters} onRemove={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: 'sensors/#' }));

    expect(useSelectionStore.getState().selected).toEqual({ label: 'sensors/#', filter: 'sensors/#', topic: 'sensors/#' });
  });

  it('keeps the focus when the selected filter is clicked again', async () => {
    render(<FilterChips filters={filters} onRemove={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: 'sensors/#' }));
    await userEvent.click(screen.getByRole('button', { name: 'sensors/#' }));

    expect(useSelectionStore.getState().selected).toEqual({ label: 'sensors/#', filter: 'sensors/#', topic: 'sensors/#' });
  });

  it('marks the selected chip as pressed', async () => {
    render(<FilterChips filters={filters} onRemove={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: 'sensors/#' }));

    expect(screen.getByRole('button', { name: 'sensors/#' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'devices/+/state' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('still unsubscribes from the dismiss button', async () => {
    const onRemove = vi.fn();
    render(<FilterChips filters={filters} onRemove={onRemove} />);

    await userEvent.click(screen.getByRole('button', { name: 'Unsubscribe from sensors/#' }));

    expect(onRemove).toHaveBeenCalledWith('sensors/#');
    expect(useSelectionStore.getState().selected).toBeNull();
  });
});

// A chip is already a filter, so it is its own answer.
it('records the chip as the topic a colour rule would cover', async () => {
  render(<FilterChips filters={['sensors/#']} onRemove={vi.fn()} />);

  await userEvent.click(screen.getByRole('button', { name: 'sensors/#' }));

  expect(useSelectionStore.getState().selected?.topic).toBe('sensors/#');
});
