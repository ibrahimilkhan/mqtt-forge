import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderWithClient as render } from '../../test/renderWithClient';
import { useLogStore } from '../../stores/logStore';
import { useSelectionStore } from '../../stores/selectionStore';
import { HoldButton } from './HoldButton';
import { usePauseStore } from '../../stores/pauseStore';
import { useHoldStore } from './useTraffic';

const chip = { label: 'sensors/#', filter: 'sensors/#' };
const readings = (topic: string, ...bodies: string[]) =>
  bodies.forEach((body) => useLogStore.getState().push({ kind: 'recv', topic, body }));

beforeEach(() => {
  useLogStore.getState().clear();
  useSelectionStore.getState().clear();
  useHoldStore.getState().release();
});

/**
 * The narrow pause: it stops one run redrawing and leaves everything else alone. The other one,
 * in the rail, stops the console taking messages at all — these tests are about telling the two
 * apart, and about the control saying nothing when there is no run to stop.
 */
describe('the pause on one run', () => {
  it('is not there at all until a topic has been picked', () => {
    render(<HoldButton />);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('appears once there is a run to hold', () => {
    readings('sensors/temp', '21');
    act(() => useSelectionStore.getState().select(chip));

    render(<HoldButton />);

    expect(screen.getByRole('button', { name: 'Pause the pane' })).toBeInTheDocument();
  });

  // It stops a pane; it does not stop the console. The tree, the other panes and the broker
  // carry on, which is the whole difference between this and the one in the rail.
  it('leaves the traffic arriving behind it', async () => {
    readings('sensors/temp', '21', '22');
    act(() => useSelectionStore.getState().select(chip));

    render(<HoldButton />);
    await userEvent.click(screen.getByRole('button', { name: 'Pause the pane' }));
    act(() => readings('sensors/temp', '23', '24'));

    expect(useLogStore.getState().held).toBe(4);
    expect(usePauseStore.getState().paused).toBe(false);
  });

  it('takes the hold over the run that is selected, not another', async () => {
    readings('sensors/temp', '21');
    readings('plant/kiln', '900');
    act(() => useSelectionStore.getState().select(chip));

    render(<HoldButton />);
    await userEvent.click(screen.getByRole('button', { name: 'Pause the pane' }));

    expect(useHoldStore.getState().held?.filter).toBe('sensors/#');
  });

  // On a tree row there is room for the figure, and it is the whole reason to look at the
  // control while a hold is on: how far behind the pane has fallen.
  it('says how many arrived behind it, on the row and out loud', async () => {
    readings('sensors/temp', '21');
    act(() => useSelectionStore.getState().select(chip));

    render(<HoldButton />);
    await userEvent.click(screen.getByRole('button', { name: 'Pause the pane' }));
    act(() => readings('sensors/temp', '22', '23'));

    const button = screen.getByRole('button');
    expect(button).toHaveTextContent('2');
    expect(button).toHaveAccessibleName('Let the pane go, 2 arrived while it was paused');
  });
});
