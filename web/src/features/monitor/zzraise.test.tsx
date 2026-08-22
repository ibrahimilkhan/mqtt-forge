import { act, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderWithClient as render } from '../../test/renderWithClient';
import { useLogStore } from '../../stores/logStore';
import { ChartWindows } from './ChartWindows';
import { useChartWindows } from './useChartWindows';

const readings = (topic: string, ...bodies: string[]) =>
  bodies.forEach((body) => useLogStore.getState().push({ kind: 'recv', topic, body }));

beforeEach(() => {
  useLogStore.getState().clear();
  useChartWindows.setState({ windows: [] });
});

describe('raising a window that the keyboard has just reached', () => {
  it('keeps focus on the control that was tabbed into', () => {
    readings('sensors/kiln', '900', '910', '920');
    readings('sensors/room', '21', '22', '23');

    const box = { x: 10, y: 10, w: 400, h: 300 };
    useChartWindows.setState({
      windows: [
        { id: 'chart-1', filter: 'sensors/kiln', label: 'sensors/kiln', box, fixed: true },
        { id: 'chart-2', filter: 'sensors/room', label: 'sensors/room', box, fixed: true },
      ],
    });

    render(<ChartWindows />);

    const pin = screen.getByRole('button', { name: 'Let sensors/kiln move' });
    act(() => pin.focus());

    expect(useChartWindows.getState().windows.map((w) => w.id)).toEqual(['chart-2', 'chart-1']);
    expect(document.activeElement).toBe(pin);
  });
});
