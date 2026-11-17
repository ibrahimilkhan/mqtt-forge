import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import designbox from '../model/fixtures/designbox-v1.json';
import { blankScene } from '../model/defaults';
import { server } from '../../../test/server';
import { renderWithClient as render } from '../../../test/renderWithClient';
import { isDirty, studioStore } from '../studioStore';
import { SAVE_DEBOUNCE_MS, useAutosave } from '../useAutosave';
import { SceneMenu } from './SceneMenu';

const flush = () => Promise.resolve();
const settle = () => Promise.resolve(() => {});

/** The menu as the studio wires it: switching and deleting go through a real autosave. */
function Saved() {
  const save = useAutosave();
  return <SceneMenu flush={save.flush} settle={save.settle} />;
}
/** The menu is the toolbar's first dropdown; everything in it is there only while it is open. */
const openMenu = () => userEvent.click(screen.getByRole('button', { name: /^Scene:/ }));
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
    await openMenu();
    await userEvent.click(await screen.findByRole('button', { name: 'Cell B' }));
    await waitFor(() => expect(studioStore.getState().scene?.name).toBe('Cell B'));
  });

  it('starts a new, unsaved scene', async () => {
    render(<SceneMenu flush={flush} settle={settle} />);
    await openMenu();
    await userEvent.click(screen.getByRole('button', { name: 'New scene' }));
    expect(studioStore.getState().scene?.name).toBe('Untitled scene');
    expect(studioStore.getState().scene?.id).not.toBe(current.id);
  });

  it('renames the scene', async () => {
    render(<SceneMenu flush={flush} settle={settle} />);
    await openMenu();
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

    await openMenu();
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

    await openMenu();
    await userEvent.click(await screen.findByRole('button', { name: 'Cell B' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Disk full');
    expect(studioStore.getState().scene?.id).toBe(current.id);
    expect(studioStore.getState().scene?.objects).toHaveLength(1);
  });

  it('lets a save already on its way finish before deleting, and writes nothing after', async () => {
    const order: string[] = [];
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    server.use(
      http.put('/api/studio/scenes/:id', async ({ params }) => {
        order.push(`PUT ${String(params.id)}`);
        await held;
        order.push(`PUT ${String(params.id)} done`);
        return new HttpResponse(null, { status: 204 });
      }),
      http.delete(`/api/studio/scenes/${current.id}`, () => {
        order.push(`DELETE ${current.id}`);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    render(<Saved />);
    act(() => void studioStore.getState().addPrimitive('box', [0, 0, 0]));
    await waitFor(() => expect(order).toEqual([`PUT ${current.id}`]));

    await openMenu();
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete Cell A' }));
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(order).toEqual([`PUT ${current.id}`]);

    await act(async () => release());
    await waitFor(() => expect(studioStore.getState().scene?.id).toBe(other.id));
    await act(() => new Promise((resolve) => setTimeout(resolve, SAVE_DEBOUNCE_MS + 100)));
    expect(order).toEqual([`PUT ${current.id}`, `PUT ${current.id} done`, `DELETE ${current.id}`]);
  });

  it('an edit made while the scene is being deleted never writes it back', async () => {
    const order: string[] = [];
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    server.use(
      http.put('/api/studio/scenes/:id', ({ params }) => {
        order.push(`PUT ${String(params.id)}`);
        return new HttpResponse(null, { status: 204 });
      }),
      http.delete(`/api/studio/scenes/${current.id}`, async () => {
        order.push(`DELETE ${current.id}`);
        await held;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    render(<Saved />);

    await openMenu();
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete Cell A' }));
    await waitFor(() => expect(order).toEqual([`DELETE ${current.id}`]));
    act(() => void studioStore.getState().addPrimitive('box', [0, 0, 0]));
    // Long enough for the pause after that edit to run out while the delete is still held.
    await act(() => new Promise((resolve) => setTimeout(resolve, SAVE_DEBOUNCE_MS + 100)));

    await act(async () => release());
    await waitFor(() => expect(studioStore.getState().scene?.id).toBe(other.id));
    expect(order).toEqual([`DELETE ${current.id}`]);
  });

  it('keeps the edits unsaved and says why when the server will not delete the scene', async () => {
    const order: string[] = [];
    // Every save fails, so the edit is unsaved whether or not the timer's save gets in before the
    // delete — the outcome does not hang on how fast the two clicks are.
    server.use(
      http.put('/api/studio/scenes/:id', ({ params }) => {
        order.push(`PUT ${String(params.id)}`);
        return HttpResponse.json({ status: 500, title: 'Could not save the studio', detail: 'Disk full', reason: 'studioNotSaved' }, { status: 500 });
      }),
      http.delete(`/api/studio/scenes/${current.id}`, () => {
        order.push(`DELETE ${current.id}`);
        return HttpResponse.json({ status: 500, title: 'Could not delete the scene', detail: 'Disk locked', reason: 'studioNotSaved' }, { status: 500 });
      }),
    );
    render(<Saved />);
    act(() => void studioStore.getState().addPrimitive('box', [0, 0, 0]));

    await openMenu();
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete Cell A' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Disk locked');
    expect(studioStore.getState().scene?.id).toBe(current.id);
    expect(studioStore.getState().scene?.objects).toHaveLength(1);
    expect(isDirty(studioStore.getState())).toBe(true);
    // Still unsaved, so the autosave picks it up again.
    await waitFor(() => expect(order.slice(order.indexOf(`DELETE ${current.id}`))).toContain(`PUT ${current.id}`));
  });

  it('takes a scene another console already deleted as deleted, and opens what is left', async () => {
    server.use(http.delete(`/api/studio/scenes/${current.id}`, () =>
      HttpResponse.json({ status: 404, title: 'No such scene', reason: 'sceneUnknown' }, { status: 404 })));
    render(<Saved />);
    act(() => void studioStore.getState().addPrimitive('box', [0, 0, 0]));

    await openMenu();
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete Cell A' }));

    await waitFor(() => expect(studioStore.getState().scene?.id).toBe(other.id));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('starts a new scene, and says why, when the one left after a delete cannot be opened', async () => {
    server.use(
      http.delete(`/api/studio/scenes/${current.id}`, () => new HttpResponse(null, { status: 204 })),
      http.get(`/api/studio/scenes/${other.id}`, () =>
        HttpResponse.json({ status: 500, title: 'Could not read the scene', detail: 'Bad sector', reason: 'studioNotRead' }, { status: 500 })),
    );
    render(<SceneMenu flush={flush} settle={settle} />);

    await openMenu();
    await screen.findByRole('button', { name: 'Cell B' });
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete Cell A' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/"Cell B" could not be opened: Bad sector/);
    expect(studioStore.getState().scene?.name).toBe('Untitled scene');
    expect([current.id, other.id]).not.toContain(studioStore.getState().scene?.id);
  });

  it('imports a DesignBox scene, uploading its models first', async () => {
    server.use(http.post('/api/studio/models', () => HttpResponse.json({ key: 'a'.repeat(64) + '.stl' })));
    render(<SceneMenu flush={flush} settle={settle} />);

    const file = new File([JSON.stringify(designbox)], 'robot-cell.json', { type: 'application/json' });
    await openMenu();
    await userEvent.upload(screen.getByLabelText('Import a DesignBox scene'), file);

    await waitFor(() => expect(studioStore.getState().scene?.name).toBe('robot-cell'));
    expect(studioStore.getState().scene?.objects[2].model?.key).toBe('a'.repeat(64) + '.stl');
  });

  it('gives an imported studio scene an id of its own, so saving it cannot write over the scene it came from', async () => {
    render(<SceneMenu flush={flush} settle={settle} />);

    const file = new File([JSON.stringify({ ...other, name: 'Cell B again' })], 'cell-b.json', { type: 'application/json' });
    await openMenu();
    await userEvent.upload(screen.getByLabelText('Import a DesignBox scene'), file);

    await waitFor(() => expect(studioStore.getState().scene?.name).toBe('Cell B again'));
    expect(studioStore.getState().scene?.id).not.toBe(other.id);
    expect(isDirty(studioStore.getState())).toBe(true);
  });

  it('says why a file could not be imported', async () => {
    render(<SceneMenu flush={flush} settle={settle} />);
    const file = new File(['{"version": 9, "objects": []}'], 'future.json', { type: 'application/json' });
    await openMenu();
    await userEvent.upload(screen.getByLabelText('Import a DesignBox scene'), file);
    expect(await screen.findByText(/newer version/)).toBeInTheDocument();
  });

  it('names the open scene on its button, marks it in the list, and shuts once another is opened', async () => {
    render(<SceneMenu flush={flush} settle={settle} />);
    const trigger = screen.getByRole('button', { name: 'Scene: Cell A' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');

    await openMenu();
    expect(screen.getByRole('button', { name: 'Cell A' })).toHaveAttribute('aria-current', 'true');
    expect(await screen.findByRole('button', { name: 'Cell B' })).toHaveAttribute('aria-current', 'false');
    await userEvent.click(screen.getByRole('button', { name: 'Cell B' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Scene: Cell B' })).toBeInTheDocument());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renames in one undo step, and Escape in the name field keeps the menu and the old name', async () => {
    render(<SceneMenu flush={flush} settle={settle} />);
    const steps = studioStore.getState().history.past.length;
    await openMenu();

    await userEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Scene name' }), ' wide{Escape}');
    expect(studioStore.getState().scene?.name).toBe('Cell A');
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Scene name' }), ' wide{Enter}');
    expect(studioStore.getState().scene?.name).toBe('Cell A wide');
    expect(studioStore.getState().history.past).toHaveLength(steps + 1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('marks both deletes as something going, and Keep backs out of it', async () => {
    render(<SceneMenu flush={flush} settle={settle} />);
    await openMenu();

    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByRole('button', { name: 'Delete Cell A' })).toHaveClass('ends');
    await userEvent.click(screen.getByRole('button', { name: 'Keep' }));

    expect(screen.getByRole('button', { name: 'Delete' })).toHaveClass('ends');
    expect(studioStore.getState().scene?.id).toBe(current.id);
  });

  it('opens the menu again to say why, when work it shut on has failed', async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    server.use(http.put('/api/studio/scenes/:id', async () => {
      await held;
      return HttpResponse.json({ status: 500, title: 'Could not save the studio', detail: 'Disk full', reason: 'studioNotSaved' }, { status: 500 });
    }));
    render(<Saved />);
    act(() => void studioStore.getState().addPrimitive('box', [0, 0, 0]));

    await openMenu();
    await userEvent.click(await screen.findByRole('button', { name: 'Cell B' }));
    // Shut before the write has come back — the failure still has to be said somewhere.
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await act(async () => release());

    expect(await screen.findByRole('alert')).toHaveTextContent('Disk full');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
