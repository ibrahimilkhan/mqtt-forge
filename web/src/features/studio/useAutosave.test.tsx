import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../test/server';
import { blankScene } from './model/defaults';
import { isDirty, studioStore } from './studioStore';
import { useAutosave } from './useAutosave';

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
);

beforeEach(() => studioStore.getState().open(blankScene('Cell')));
afterEach(() => vi.useRealTimers());

describe('useAutosave', () => {
  it('saves a change after a pause and marks it saved', async () => {
    const puts: unknown[] = [];
    server.use(http.put('/api/studio/scenes/:id', async ({ request }) => {
      puts.push(await request.json());
      return new HttpResponse(null, { status: 204 });
    }));
    const { result } = renderHook(() => useAutosave(), { wrapper });

    act(() => void studioStore.getState().addPrimitive('box', [0, 0, 0]));

    await waitFor(() => expect(puts).toHaveLength(1));
    await waitFor(() => expect(result.current.state.kind).toBe('saved'));
    expect(isDirty(studioStore.getState())).toBe(false);
  });

  it('keeps the change and says so when the save fails, and saves it on retry', async () => {
    let fail = true;
    server.use(http.put('/api/studio/scenes/:id', () =>
      fail
        ? HttpResponse.json({ status: 500, title: 'Could not save the studio', detail: 'Disk full', reason: 'studioNotSaved' }, { status: 500 })
        : new HttpResponse(null, { status: 204 })));
    const { result } = renderHook(() => useAutosave(), { wrapper });

    act(() => void studioStore.getState().addPrimitive('box', [0, 0, 0]));
    await waitFor(() => expect(result.current.state.kind).toBe('failed'));
    expect(isDirty(studioStore.getState())).toBe(true);

    fail = false;
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.state.kind).toBe('saved'));
  });

  it('flush saves straight away rather than after the pause', async () => {
    let saved = false;
    server.use(http.put('/api/studio/scenes/:id', () => {
      saved = true;
      return new HttpResponse(null, { status: 204 });
    }));
    const { result } = renderHook(() => useAutosave(), { wrapper });

    act(() => void studioStore.getState().addPrimitive('box', [0, 0, 0]));
    await act(() => result.current.flush());
    expect(saved).toBe(true);
  });
});
