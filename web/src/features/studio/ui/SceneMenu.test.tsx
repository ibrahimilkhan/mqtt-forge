import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import designbox from '../model/fixtures/designbox-v1.json';
import { blankScene } from '../model/defaults';
import { server } from '../../../test/server';
import { renderWithClient as render } from '../../../test/renderWithClient';
import { studioStore } from '../studioStore';
import { SAVE_DEBOUNCE_MS, useAutosave } from '../useAutosave';
import { SceneMenu } from './SceneMenu';

const flush = () => Promise.resolve();
const settle = () => Promise.resolve();

/** The menu as the studio wires it: switching and deleting go through a real autosave. */
function Saved() {
  const save = useAutosave();
  return <SceneMenu flush={save.flush} settle={save.settle} />;
}
const current = blankScene('Cell A');
const other = blankScene('Cell B');

beforeEach(() => {
  studioStore.getState().open(current);
  server.use(
    http.get('/api/studio/scenes', () =>
      HttpResponse.json([
        { id: current.id, name: 'Cell A', updatedAt: current.updatedAt },
        { id: other.id, name: 'Cell B', updatedAt: other.updatedAt },
      ])),
    http.get(`/api/studio/scenes/${other.id}`, () => HttpResponse.json(other)),
  );
});

describe('SceneMenu', () => {
  it('opens another scene from the list', async () => {
    render(<SceneMenu flush={flush} settle={settle} />);
    await screen.findByRole('option', { name: 'Cell B' });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Scene' }), other.id);
    await waitFor(() => expect(studioStore.getState().scene?.name).toBe('Cell B'));
  });

  it('starts a new, unsaved scene', async () => {
    render(<SceneMenu flush={flush} settle={settle} />);
    await userEvent.click(screen.getByRole('button', { name: 'New scene' }));
    expect(studioStore.getState().scene?.name).toBe('Untitled scene');
    expect(studioStore.getState().scene?.id).not.toBe(current.id);
  });

  it('renames the scene', async () => {
    render(<SceneMenu flush={flush} settle={settle} />);
    await userEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const field = screen.getByRole('textbox', { name: 'Scene name' });
    await userEvent.clear(field);
    await userEvent.type(field, 'Line 3{Enter}');
    expect(studioStore.getState().scene?.name).toBe('Line 3');
  });

  it('asks before deleting, and opens what is left after', async () => {
    let deleted = false;
    server.use(http.delete(`/api/studio/scenes/${current.id}`, () => {
      deleted = true;
      return new HttpResponse(null, { status: 204 });
    }));
    render(<SceneMenu flush={flush} settle={settle} />);

    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(deleted).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Delete Cell A' }));

    await waitFor(() => expect(deleted).toBe(true));
    await waitFor(() => expect(studioStore.getState().scene?.id).toBe(other.id));
  });

  it('stays on a scene that could not be saved, and says why, rather than switching away', async () => {
    server.use(http.put('/api/studio/scenes/:id', () =>
      HttpResponse.json({ status: 500, title: 'Could not save the studio', detail: 'Disk full', reason: 'studioNotSaved' }, { status: 500 })));
    render(<Saved />);
    act(() => void studioStore.getState().addPrimitive('box', [0, 0, 0]));

    await screen.findByRole('option', { name: 'Cell B' });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Scene' }), other.id);

    expect(await screen.findByRole('alert')).toHaveTextContent(/Disk full|Could not save/);
    expect(studioStore.getState().scene?.id).toBe(current.id);
    expect(studioStore.getState().scene?.objects).toHaveLength(1);
  });

  it('deleting the open scene straight after a change never writes it back', async () => {
    const order: string[] = [];
    server.use(
      http.put('/api/studio/scenes/:id', ({ params }) => {
        order.push(`PUT ${String(params.id)}`);
        return new HttpResponse(null, { status: 204 });
      }),
      // Slow enough that the pause after the change runs out while the delete is on its way.
      http.delete(`/api/studio/scenes/${current.id}`, async () => {
        order.push(`DELETE ${current.id}`);
        await delay(SAVE_DEBOUNCE_MS + 200);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    render(<Saved />);
    act(() => void studioStore.getState().addPrimitive('box', [0, 0, 0]));

    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete Cell A' }));
    await waitFor(() => expect(studioStore.getState().scene?.id).toBe(other.id), { timeout: 3000 });
    await act(() => new Promise((resolve) => setTimeout(resolve, SAVE_DEBOUNCE_MS + 100)));

    const deletedAt = order.indexOf(`DELETE ${current.id}`);
    expect(deletedAt).toBeGreaterThanOrEqual(0);
    expect(order.slice(deletedAt)).not.toContain(`PUT ${current.id}`);
  });

  it('imports a DesignBox scene, uploading its models first', async () => {
    server.use(http.post('/api/studio/models', () => HttpResponse.json({ key: 'a'.repeat(64) + '.stl' })));
    render(<SceneMenu flush={flush} settle={settle} />);

    const file = new File([JSON.stringify(designbox)], 'robot-cell.json', { type: 'application/json' });
    await userEvent.upload(screen.getByLabelText('Import a DesignBox scene'), file);

    await waitFor(() => expect(studioStore.getState().scene?.name).toBe('robot-cell'));
    expect(studioStore.getState().scene?.objects[2].model?.key).toBe('a'.repeat(64) + '.stl');
  });

  it('says why a file could not be imported', async () => {
    render(<SceneMenu flush={flush} settle={settle} />);
    const file = new File(['{"version": 9, "objects": []}'], 'future.json', { type: 'application/json' });
    await userEvent.upload(screen.getByLabelText('Import a DesignBox scene'), file);
    expect(await screen.findByText(/newer version/)).toBeInTheDocument();
  });
});
