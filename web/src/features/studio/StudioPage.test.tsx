import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { server } from '../../test/server';
import { renderWithClient as render } from '../../test/renderWithClient';
import { blankScene } from './model/defaults';
import { studioStore } from './studioStore';
import StudioPage from './StudioPage';

beforeEach(() => studioStore.getState().close());

describe('StudioPage', () => {
  it('starts a new scene when there are none, and lays out the studio around it', async () => {
    render(<StudioPage />);

    expect(await screen.findByRole('combobox', { name: 'Scene' })).toHaveDisplayValue('Untitled scene');
    expect(screen.getByRole('toolbar', { name: 'Studio tools' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Objects' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Inspector' })).toBeInTheDocument();
  });

  it('opens the most recently saved scene', async () => {
    const older = { ...blankScene('Older'), updatedAt: '2026-01-01T00:00:00Z' };
    const newer = { ...blankScene('Newer'), updatedAt: '2026-06-01T00:00:00Z' };
    server.use(
      http.get('/api/studio/scenes', () => HttpResponse.json([older, newer].map(({ id, name, updatedAt }) => ({ id, name, updatedAt })))),
      http.get(`/api/studio/scenes/${newer.id}`, () => HttpResponse.json(newer)),
    );

    render(<StudioPage />);

    expect(await screen.findByRole('combobox', { name: 'Scene' })).toHaveDisplayValue('Newer');
  });

  // jsdom has no WebGL — the same as a browser with it switched off.
  it('says when 3D cannot be drawn, and the rest of the studio still works', async () => {
    render(<StudioPage />);
    expect(await screen.findByText(/cannot draw 3D/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Add Box' }));
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

    expect(await screen.findByRole('combobox', { name: 'Scene' })).toHaveDisplayValue('Older');
    expect(screen.getByText(/"Newer" could not be opened/)).toHaveAttribute('role', 'alert');
    expect(screen.getByRole('button', { name: 'New scene' })).toBeInTheDocument();
  });
});
