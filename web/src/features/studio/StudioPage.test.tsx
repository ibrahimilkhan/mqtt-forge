import { act, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { server } from '../../test/server';
import { renderWithClient as render } from '../../test/renderWithClient';
import { blankScene } from './model/defaults';
import { LAYOUT_DEFAULTS, LAYOUT_KEY, useStudioLayout } from './layoutStore';
import { studioStore } from './studioStore';
import StudioPage from './StudioPage';

beforeEach(() => {
  studioStore.getState().close();
  useStudioLayout.setState(LAYOUT_DEFAULTS);
});

describe('StudioPage', () => {
  it('starts a new scene when there are none, and lays out the studio around it', async () => {
    render(<StudioPage />);

    expect(await screen.findByRole('button', { name: 'Scene: Untitled scene' })).toBeInTheDocument();
    expect(screen.getByRole('toolbar', { name: 'Studio tools' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Objects' })).toBeInTheDocument();
    // Nothing is selected in a new scene, so there is no inspector to float over the view.
    expect(screen.queryByRole('complementary', { name: 'Inspector' })).not.toBeInTheDocument();
  });

  it('opens the most recently saved scene', async () => {
    const older = { ...blankScene('Older'), updatedAt: '2026-01-01T00:00:00Z' };
    const newer = { ...blankScene('Newer'), updatedAt: '2026-06-01T00:00:00Z' };
    server.use(
      http.get('/api/studio/scenes', () => HttpResponse.json([older, newer].map(({ id, name, updatedAt }) => ({ id, name, updatedAt })))),
      http.get(`/api/studio/scenes/${newer.id}`, () => HttpResponse.json(newer)),
    );

    render(<StudioPage />);

    expect(await screen.findByRole('button', { name: 'Scene: Newer' })).toBeInTheDocument();
  });

  // jsdom has no WebGL — the same as a browser with it switched off.
  it('says when 3D cannot be drawn, and the rest of the studio still works', async () => {
    render(<StudioPage />);
    expect(await screen.findByText(/cannot draw 3D/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Add a shape' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Box' }));
    expect(screen.getByRole('button', { name: 'Box 1' })).toBeInTheDocument();
  });

  it('says when the scene list cannot be read', async () => {
    server.use(http.get('/api/studio/scenes', () => HttpResponse.json({ status: 500, title: 'Broken' }, { status: 500 })));
    render(<StudioPage />);
    expect(await screen.findByText(/scene list could not be read/)).toBeInTheDocument();
  });

  it('says inside the studio when the newest scene cannot be opened, and still lets the reader choose', async () => {
    const older = { ...blankScene('Older'), updatedAt: '2026-01-01T00:00:00Z' };
    const newer = { ...blankScene('Newer'), updatedAt: '2026-06-01T00:00:00Z' };
    server.use(
      http.get('/api/studio/scenes', () => HttpResponse.json([older, newer].map(({ id, name, updatedAt }) => ({ id, name, updatedAt })))),
      http.get(`/api/studio/scenes/${newer.id}`, () => HttpResponse.json({ status: 500, title: 'Broken', detail: 'Bad sector' }, { status: 500 })),
      http.get(`/api/studio/scenes/${older.id}`, () => HttpResponse.json(older)),
    );

    render(<StudioPage />);

    expect(await screen.findByRole('button', { name: 'Scene: Older' })).toBeInTheDocument();
    expect(screen.getByText(/"Newer" could not be opened/)).toHaveAttribute('role', 'alert');
    await userEvent.click(screen.getByRole('button', { name: 'Scene: Older' }));
    expect(screen.getByRole('button', { name: 'New scene' })).toBeInTheDocument();
  });

  it('draws the inspector only while something is selected and its switch is on', async () => {
    render(<StudioPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Add a shape' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Box' }));
    expect(screen.getByRole('complementary', { name: 'Inspector' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Inspector' }));
    expect(screen.queryByRole('complementary', { name: 'Inspector' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Inspector' }));
    expect(screen.getByRole('complementary', { name: 'Inspector' })).toBeInTheDocument();
    act(() => studioStore.getState().select([]));
    expect(screen.queryByRole('complementary', { name: 'Inspector' })).not.toBeInTheDocument();
  });

  it('shuts and opens the object tree, and keeps the choice for the next visit', async () => {
    render(<StudioPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Object tree' }));
    expect(screen.queryByRole('navigation', { name: 'Objects' })).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}').state).toMatchObject({ treeOpen: false });

    await userEvent.click(screen.getByRole('button', { name: 'Object tree' }));
    expect(screen.getByRole('navigation', { name: 'Objects' })).toBeInTheDocument();
  });

  it('shuts an open menu on Escape without clearing the selection behind it', async () => {
    render(<StudioPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Add a shape' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Box' }));
    const selected = studioStore.getState().selection;
    expect(selected).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: 'Add a shape' }));
    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(studioStore.getState().selection).toEqual(selected);
    // And with the menu shut, the same key is the studio's again.
    await userEvent.keyboard('{Escape}');
    expect(studioStore.getState().selection).toEqual([]);
  });

  /** The whole sequence a real mouse sends, pressed on the mark inside the button as a hand does. */
  const press = (button: HTMLElement) => {
    const on = (button.querySelector('span, svg') as HTMLElement | null) ?? button;
    act(() => {
      fireEvent.pointerDown(on, { button: 0 });
      fireEvent.mouseDown(on, { button: 0 });
      fireEvent.pointerUp(on, { button: 0 });
      fireEvent.mouseUp(on, { button: 0 });
      fireEvent.click(on);
    });
  };

  it.each([
    ['Scene', /^Scene:/, 'dialog'],
    ['Add', /^Add a shape$/, 'menu'],
    ['Steps', /^Snap steps$/, 'dialog'],
  ] as const)('opens the %s menu on a whole real press and keeps it open', async (_, name, role) => {
    render(<StudioPage />);
    const trigger = await screen.findByRole('button', { name });

    press(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole(role)).toBeInTheDocument();
  });

  it('leaves the selection alone when the scene menu is opened, and when the open scene is picked from it', async () => {
    render(<StudioPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Add a shape' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Box' }));
    const before = studioStore.getState();
    expect(before.selection).toHaveLength(1);

    press(screen.getByRole('button', { name: /^Scene:/ }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // The open scene has the keyboard, so an Enter here cannot switch to another one.
    expect(screen.getByRole('button', { name: 'Untitled scene' })).toHaveFocus();
    expect(studioStore.getState().selection).toEqual(before.selection);
    expect(screen.getByRole('complementary', { name: 'Inspector' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Untitled scene' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(studioStore.getState().scene).toBe(before.scene);
    expect(studioStore.getState().selection).toEqual(before.selection);
  });
});
