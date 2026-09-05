import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSelectionStore } from '../../stores/selectionStore';
import { FilterChips } from './FilterChips';

const filters = [
  { topicFilter: 'sensors/#', console: true, rules: false },
  { topicFilter: 'devices/+/state', console: true, rules: false },
];

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
  render(<FilterChips filters={[{ topicFilter: 'sensors/#', console: true, rules: false }]} onRemove={vi.fn()} />);

  await userEvent.click(screen.getByRole('button', { name: 'sensors/#' }));

  expect(useSelectionStore.getState().selected?.topic).toBe('sensors/#');
});

// A filter only an alert rule holds is not this console's to drop: the × would send an
// UNSUBSCRIBE the subscriber refuses to act on, and the chip would come straight back.
it('offers no × for a filter an alert rule holds', () => {
  const onRemove = vi.fn();
  render(
    <FilterChips
      filters={[{ topicFilter: 'plant/#', console: false, rules: true }]}
      onRemove={onRemove}
    />,
  );

  const cross = screen.getByRole('button', { name: 'plant/# is held by an alert rule' });

  expect(cross).toBeDisabled();
  expect(onRemove).not.toHaveBeenCalled();
});

// ...but a filter the console asked for as well is still its own to let go of.
it('keeps the × when the console holds it too', () => {
  render(
    <FilterChips
      filters={[{ topicFilter: 'plant/#', console: true, rules: true }]}
      onRemove={vi.fn()}
    />,
  );

  expect(screen.getByRole('button', { name: 'Unsubscribe from plant/#' })).toBeEnabled();
});
