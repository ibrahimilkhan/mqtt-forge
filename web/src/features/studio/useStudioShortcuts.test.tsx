import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { blankScene } from './model/defaults';
import { studioStore } from './studioStore';
import { useStudioShortcuts } from './useStudioShortcuts';

function Host({ focus = () => {} }: { focus?: () => void }) {
  const onKeyDown = useStudioShortcuts({ focus });
  return (
    <div tabIndex={-1} data-testid="root" onKeyDown={onKeyDown}>
      <input aria-label="typing" />
    </div>
  );
}

beforeEach(() => {
  studioStore.getState().open(blankScene('Cell'));
  // The store outlives each test, and the tool deliberately survives opening a scene.
  studioStore.getState().setTool('move');
});

describe('studio shortcuts', () => {
  it('picks tools with W, E, R and Q', () => {
    const { getByTestId } = render(<Host />);
    fireEvent.keyDown(getByTestId('root'), { key: 'e' });
    expect(studioStore.getState().tool).toBe('rotate');
    fireEvent.keyDown(getByTestId('root'), { key: 'r' });
    expect(studioStore.getState().tool).toBe('scale');
    fireEvent.keyDown(getByTestId('root'), { key: 'q' });
    expect(studioStore.getState().tool).toBe('select');
  });

  it('deletes the selection, and undoes with Ctrl+Z', () => {
    const { getByTestId } = render(<Host />);
    studioStore.getState().addPrimitive('box', [0, 0, 0]);
    fireEvent.keyDown(getByTestId('root'), { key: 'Delete' });
    expect(studioStore.getState().scene!.objects).toHaveLength(0);
    fireEvent.keyDown(getByTestId('root'), { key: 'z', ctrlKey: true });
    expect(studioStore.getState().scene!.objects).toHaveLength(1);
  });

  it('duplicates with Ctrl+D and focuses with F', () => {
    const focus = vi.fn();
    const { getByTestId } = render(<Host focus={focus} />);
    studioStore.getState().addPrimitive('box', [0, 0, 0]);
    fireEvent.keyDown(getByTestId('root'), { key: 'd', ctrlKey: true });
    expect(studioStore.getState().scene!.objects).toHaveLength(2);
    fireEvent.keyDown(getByTestId('root'), { key: 'f' });
    expect(focus).toHaveBeenCalled();
  });

  // Typing a name must not delete the object or switch the tool.
  it('leaves keys alone while a field is being typed in', () => {
    const { getByLabelText } = render(<Host />);
    studioStore.getState().addPrimitive('box', [0, 0, 0]);
    fireEvent.keyDown(getByLabelText('typing'), { key: 'Delete' });
    fireEvent.keyDown(getByLabelText('typing'), { key: 'e' });
    expect(studioStore.getState().scene!.objects).toHaveLength(1);
    expect(studioStore.getState().tool).toBe('move');
  });
});
