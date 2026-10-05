import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsoleReveal, FACES_CAP_MS } from './ConsoleReveal';
import { CONSOLE_DRAWN, REVEAL_ATTRIBUTE, SHELL_ATTRIBUTE, SHELL_WEBVIEW } from './shell';

type Hosted = Window & { chrome?: { webview?: { postMessage: (message: unknown) => void } } };

const html = document.documentElement;
const reveal = () => html.getAttribute(REVEAL_ATTRIBUTE);
const twoFrames = () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));

let root: HTMLElement;
let lockup: HTMLElement;

// What index.html hands React: the lockup beside #root, and #root to render into.
beforeEach(() => {
  lockup = document.createElement('div');
  lockup.className = 'boot-lockup';
  root = document.createElement('div');
  root.id = 'root';
  document.body.append(lockup, root);
});

afterEach(() => {
  lockup.remove();
  root.remove();
  html.removeAttribute(SHELL_ATTRIBUTE);
  html.removeAttribute(REVEAL_ATTRIBUTE);
  delete (window as Hosted).chrome;
  delete (document as { fonts?: unknown }).fonts;
});

const hosted = () => {
  const postMessage = vi.fn();
  (window as Hosted).chrome = { webview: { postMessage } };
  html.setAttribute(SHELL_ATTRIBUTE, SHELL_WEBVIEW);
  return postMessage;
};

describe('the console coming in after the lockup', () => {
  // The console is drawn at its first commit but not shown until everything its first frame needs
  // is ready. Measured, the first frame used to be set in the fallback faces and moved when Inter
  // and JetBrains Mono arrived.
  it('keeps the console covered from its first commit', () => {
    render(<ConsoleReveal />);

    expect(reveal()).toBe('covered');
    expect(lockup.isConnected).toBe(true);
  });

  // All at once: the console replaces the lockup in one frame, with no transition between them.
  it('puts the console up in one step once its faces are ready', async () => {
    render(<ConsoleReveal />);

    await waitFor(() => expect(reveal()).toBeNull());
    // The ground comes back, and the lockup the console was waiting behind goes, in the same step.
    expect(html.hasAttribute(SHELL_ATTRIBUTE)).toBe(false);
    expect(lockup.isConnected).toBe(false);
  });

  it('waits for the faces', async () => {
    let arrive!: () => void;
    (document as { fonts?: unknown }).fonts = { ready: new Promise<void>((done) => (arrive = done)) };
    render(<ConsoleReveal />);

    await twoFrames();
    expect(reveal()).toBe('covered');

    arrive();
    await waitFor(() => expect(reveal()).toBeNull());
  });

  it('does not wait on the faces for ever', async () => {
    // A face that never arrives is a console set in a fallback, which is better than a console that
    // never opens.
    (document as { fonts?: unknown }).fonts = { ready: new Promise<void>(() => {}) };
    render(<ConsoleReveal />);

    await new Promise((done) => setTimeout(done, FACES_CAP_MS + 200));

    expect(reveal()).toBeNull();
    expect(lockup.isConnected).toBe(false);
  });

  it('tells the Windows window once the console is on screen', async () => {
    const postMessage = hosted();
    render(<ConsoleReveal />);
    await waitFor(() => expect(reveal()).toBeNull());

    // Not in the same step: the window stops drawing its own lockup on this, and it must not do
    // that while the lockup is still the thing on screen.
    expect(postMessage).not.toHaveBeenCalled();
    await twoFrames();
    await twoFrames();
    expect(postMessage).toHaveBeenCalledWith(CONSOLE_DRAWN);
  });

  it('tells no window anything in a browser', async () => {
    render(<ConsoleReveal />);

    await waitFor(() => expect(reveal()).toBeNull());
    expect(lockup.isConnected).toBe(false);
  });
});
