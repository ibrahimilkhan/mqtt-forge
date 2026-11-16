import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../test/server';
import { blankScene } from './model/defaults';
import { isDirty, studioStore } from './studioStore';
import { SAVE_DEBOUNCE_MS, useAutosave } from './useAutosave';

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

  it('flush says so when the save fails, so whoever was about to move on does not', async () => {
    server.use(http.put('/api/studio/scenes/:id', () =>
      HttpResponse.json({ status: 500, title: 'Could not save the studio', detail: 'Disk full', reason: 'studioNotSaved' }, { status: 500 })));
    const { result } = renderHook(() => useAutosave(), { wrapper });

    act(() => void studioStore.getState().addPrimitive('box', [0, 0, 0]));
    await act(() => expect(result.current.flush()).rejects.toThrow());
    expect(result.current.state.kind).toBe('failed');
    expect(isDirty(studioStore.getState())).toBe(true);
  });

  it('sends a change made while a save is on its way only once that save is back, and only once', async () => {
    const puts: number[] = [];
    let sending = 0;
    let overlapped = false;
    let release = () => {};
    const firstHeld = new Promise<void>((resolve) => { release = resolve; });
    server.use(http.put('/api/studio/scenes/:id', async ({ request }) => {
      const body = (await request.json()) as { objects: unknown[] };
      sending += 1;
      if (sending > 1) overlapped = true;
      puts.push(body.objects.length);
      if (puts.length === 1) await firstHeld;
      sending -= 1;
      return new HttpResponse(null, { status: 204 });
    }));
    const { result } = renderHook(() => useAutosave(), { wrapper });

    act(() => void studioStore.getState().addPrimitive('box', [0, 0, 0]));
    let first = Promise.resolve();
    act(() => { first = result.current.flush(); });
    await waitFor(() => expect(puts).toHaveLength(1));

    act(() => void studioStore.getState().addPrimitive('box', [1, 0, 0]));
    // Two callers waiting on the same save: the timer once its pause has run out, then a flush.
    await act(() => new Promise((resolve) => setTimeout(resolve, SAVE_DEBOUNCE_MS + 100)));
    let second = Promise.resolve();
    act(() => { second = result.current.flush(); });

    await act(async () => {
      release();
      await first;
      await second;
    });
    expect(puts).toEqual([1, 2]);
    expect(overlapped).toBe(false);
    expect(isDirty(studioStore.getState())).toBe(false);
  });

  it('settle waits for the save on its way and starts no other', async () => {
    let puts = 0;
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    server.use(http.put('/api/studio/scenes/:id', async () => {
      puts += 1;
      await held;
      return new HttpResponse(null, { status: 204 });
    }));
    const { result } = renderHook(() => useAutosave(), { wrapper });

    act(() => void studioStore.getState().addPrimitive('box', [0, 0, 0]));
    let sent = Promise.resolve();
    act(() => { sent = result.current.flush(); });
    await waitFor(() => expect(puts).toBe(1));
    act(() => void studioStore.getState().addPrimitive('box', [1, 0, 0]));
    // What deleting the open scene does: nothing in it is worth writing any more.
    act(() => studioStore.getState().markSaved(studioStore.getState().revision));

    let settled = false;
    let settling = Promise.resolve();
    act(() => { settling = result.current.settle(studioStore.getState().scene!.id).then(() => { settled = true; }); });
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(settled).toBe(false);

    await act(async () => {
      release();
      await sent;
      await settling;
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, SAVE_DEBOUNCE_MS + 100)));
    expect(puts).toBe(1);
    expect(isDirty(studioStore.getState())).toBe(false);
  });

  it('writes an edit made just before the studio closes, rather than dropping it with the timer', async () => {
    const puts: unknown[] = [];
    server.use(http.put('/api/studio/scenes/:id', async ({ request }) => {
      puts.push(await request.json());
      return new HttpResponse(null, { status: 204 });
    }));
    const { unmount } = renderHook(() => useAutosave(), { wrapper });

    act(() => void studioStore.getState().addPrimitive('box', [0, 0, 0]));
    unmount();

    await waitFor(() => expect(puts).toHaveLength(1));
    await waitFor(() => expect(isDirty(studioStore.getState())).toBe(false));
  });

  it('writes the scene when the page is going away while the studio is open', async () => {
    let puts = 0;
    server.use(http.put('/api/studio/scenes/:id', () => {
      puts += 1;
      return new HttpResponse(null, { status: 204 });
    }));
    renderHook(() => useAutosave(), { wrapper });

    act(() => void studioStore.getState().addPrimitive('box', [0, 0, 0]));
    act(() => void window.dispatchEvent(new Event('pagehide')));

    // Well inside the pause: the write must not wait for a timer the page may not live to run.
    await act(() => new Promise((resolve) => setTimeout(resolve, SAVE_DEBOUNCE_MS / 5)));
    expect(puts).toBe(1);
    await waitFor(() => expect(isDirty(studioStore.getState())).toBe(false));
    // The timer's save finds nothing left to write.
    await act(() => new Promise((resolve) => setTimeout(resolve, SAVE_DEBOUNCE_MS + 100)));
    expect(puts).toBe(1);
  });

  it('does not carry a failed save onto the next scene', async () => {
    server.use(http.put('/api/studio/scenes/:id', () =>
      HttpResponse.json({ status: 500, title: 'Could not save the studio', detail: 'Disk full', reason: 'studioNotSaved' }, { status: 500 })));
    const { result } = renderHook(() => useAutosave(), { wrapper });

    act(() => void studioStore.getState().addPrimitive('box', [0, 0, 0]));
    await waitFor(() => expect(result.current.state.kind).toBe('failed'));

    act(() => studioStore.getState().open(blankScene('Cell B')));
    expect(result.current.state.kind).toBe('saved');
  });
});
