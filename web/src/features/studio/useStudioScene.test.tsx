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
});
