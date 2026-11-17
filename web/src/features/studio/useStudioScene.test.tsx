import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { queryKeys } from '../../api/queryKeys';
import { server } from '../../test/server';
import { blankScene } from './model/defaults';
import { isDirty, studioStore } from './studioStore';
import { UNTITLED, useStudioScene } from './useStudioScene';

const queryClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const wrapperOf = (client: QueryClient) => ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);
const unreadable = () =>
  HttpResponse.json({ status: 500, title: 'Could not read the scene', detail: 'Bad sector', reason: 'studioNotRead' }, { status: 500 });
const listed = (...scenes: { id: string; name: string; updatedAt: string }[]) =>
  http.get('/api/studio/scenes', () => HttpResponse.json(scenes.map(({ id, name, updatedAt }) => ({ id, name, updatedAt }))));
const listFails = () =>
  server.use(http.get('/api/studio/scenes', () =>
    HttpResponse.json({ status: 500, title: 'Could not read the studio', detail: 'Disk gone', reason: 'studioNotRead' }, { status: 500 })));

beforeEach(() => studioStore.getState().close());

describe('useStudioScene', () => {
  it('starts a new scene, not yet saved, when there are none', async () => {
    server.use(http.get('/api/studio/scenes', () => HttpResponse.json([])));
    const { result } = renderHook(() => useStudioScene(), { wrapper: wrapperOf(queryClient()) });

    await waitFor(() => expect(result.current.phase).toBe('ready'));
    expect(studioStore.getState().scene?.name).toBe(UNTITLED);
    expect(isDirty(studioStore.getState())).toBe(true);
  });

  it('says the list could not be read when there is nothing to show instead', async () => {
    listFails();
    const { result } = renderHook(() => useStudioScene(), { wrapper: wrapperOf(queryClient()) });

    await waitFor(() => expect(result.current.phase).toBe('failed'));
    expect(result.current.error).toMatch(/scene list could not be read/);
  });

  it('keeps showing the open scene when a refresh of the list fails', async () => {
    studioStore.getState().open(blankScene('Cell'));
    listFails();
    const client = queryClient();
    const { result } = renderHook(() => useStudioScene(), { wrapper: wrapperOf(client) });

    await waitFor(() => expect(client.getQueryState(queryKeys.studioScenes)?.status).toBe('error'));
    expect(result.current.phase).toBe('ready');
    expect(studioStore.getState().scene?.name).toBe('Cell');
  });

  it('opens the next scene it can read when the newest cannot be, and says which could not', async () => {
    const older = { ...blankScene('Older'), updatedAt: '2026-01-01T00:00:00Z' };
    const newer = { ...blankScene('Newer'), updatedAt: '2026-06-01T00:00:00Z' };
    server.use(
      listed(older, newer),
      http.get(`/api/studio/scenes/${newer.id}`, unreadable),
      http.get(`/api/studio/scenes/${older.id}`, () => HttpResponse.json(older)),
    );
    const { result } = renderHook(() => useStudioScene(), { wrapper: wrapperOf(queryClient()) });

    await waitFor(() => expect(result.current.phase).toBe('ready'));
    expect(studioStore.getState().scene?.id).toBe(older.id);
    expect(result.current.error).toMatch(/"Newer" could not be opened/);
  });

  it('starts a new scene when none of them can be read, and says so', async () => {
    const only = { ...blankScene('Only'), updatedAt: '2026-06-01T00:00:00Z' };
    server.use(listed(only), http.get(`/api/studio/scenes/${only.id}`, unreadable));
    const { result } = renderHook(() => useStudioScene(), { wrapper: wrapperOf(queryClient()) });

    await waitFor(() => expect(result.current.phase).toBe('ready'));
    expect(studioStore.getState().scene?.name).toBe(UNTITLED);
    expect(studioStore.getState().scene?.id).not.toBe(only.id);
    expect(result.current.error).toMatch(/"Only" could not be opened/);
  });
});
