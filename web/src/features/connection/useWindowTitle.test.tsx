import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WINDOW_TITLE } from '../shell/shell';
import { titleFor, useWindowTitle } from './useWindowTitle';

/**
 * The title says the link: in the browser's tab, and — through the desktop host — in the window's
 * own title bar, the taskbar and Alt+Tab, which are where a reader looks for a window they are not
 * looking at.
 */
describe('the title a link is given', () => {
  it.each([
    ['Connected', '127.0.0.1:18830', 'MQTTForge — 127.0.0.1:18830'],
    ['Waiting', '127.0.0.1:18830', 'MQTTForge — connecting to 127.0.0.1:18830'],
    ['Retrying', '127.0.0.1:18830', 'MQTTForge — reconnecting to 127.0.0.1:18830'],
    ['Faulted', '127.0.0.1:18830', 'MQTTForge — connection faulted · 127.0.0.1:18830'],
    ['Reconnecting', '127.0.0.1:18830', 'MQTTForge — console offline'],
    ['Disconnected', undefined, 'MQTTForge — not connected'],
  ] as const)('%s → "%s"', (state, where, title) => {
    expect(titleFor(state, where, true)).toBe(title);
  });

  it('names the state alone when there is no broker to name', () => {
    expect(titleFor('Connected', undefined, true)).toBe('MQTTForge — connected');
    expect(titleFor('Waiting', undefined, true)).toBe('MQTTForge — connecting');
  });

  // The console's Disconnected before the API answers is a stand-in: a title built on it would say
  // 'not connected' over a live link for the first beat of every reload.
  it('says only the name before the API has answered', () => {
    expect(titleFor('Disconnected', undefined, false)).toBe('MQTTForge');
  });
});

describe('useWindowTitle', () => {
  const external = window.external;

  afterEach(() => {
    Object.defineProperty(window, 'external', { value: external, configurable: true });
    document.title = '';
  });

  it('puts it on the document, which is the tab in a browser', () => {
    renderHook(() => useWindowTitle('Connected', '127.0.0.1:18830', true));

    expect(document.title).toBe('MQTTForge — 127.0.0.1:18830');
  });

  it('hands it to the desktop window, which does not follow the document by itself', () => {
    const sendMessage = vi.fn();
    Object.defineProperty(window, 'external', { value: { sendMessage }, configurable: true });

    const { rerender } = renderHook(({ state }) => useWindowTitle(state, '127.0.0.1:18830', true), {
      initialProps: { state: 'Connected' as const } as { state: 'Connected' | 'Retrying' },
    });
    rerender({ state: 'Retrying' });

    expect(sendMessage).toHaveBeenNthCalledWith(1, `${WINDOW_TITLE}MQTTForge — 127.0.0.1:18830`);
    expect(sendMessage).toHaveBeenNthCalledWith(2, `${WINDOW_TITLE}MQTTForge — reconnecting to 127.0.0.1:18830`);
  });

  it('asks nothing of a browser, whose window.external has no such thing', () => {
    // A real browser's window.external is a leftover object with no sendMessage on it.
    Object.defineProperty(window, 'external', { value: {}, configurable: true });

    expect(() => renderHook(() => useWindowTitle('Connected', '127.0.0.1:18830', true))).not.toThrow();
  });
});
