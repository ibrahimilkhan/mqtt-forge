import { useLayoutEffect } from 'react';
import './reveal.css';
import { CONSOLE_DRAWN, REVEAL_ATTRIBUTE, SHELL_ATTRIBUTE } from './shell';

/** The longest the console waits for its faces before it comes in regardless. */
export const FACES_CAP_MS = 1500;

/**
 * Puts the console up in place of the start-up lockup — covered at its first commit, then shown in
 * one step once it is ready to be looked at.
 *
 * Covered first because the first frame used to be the wrong one. Measured on the desktop window:
 * the console's first frame was set in the fallback faces, Inter and JetBrains Mono arrived 45ms
 * later and every line of type moved, and the connection chip arrived 40ms after that and pushed
 * the whole form down. The broker panel has since dropped the chip; the faces are preloaded, and
 * waited for here — behind the lockup, where the console is laid out and nobody can see it settle.
 *
 * Then all at once: the console replaces the lockup in one frame, with no transition between them.
 *
 * The lockup it waits behind is the Windows window's own drawing showing through a page that is
 * clear until now (shell.ts), and the page's lockup beside #root on macOS and in a browser — see
 * web/plugins/boot-lockup.ts.
 *
 * Rendered once, at the root, beside the app rather than inside it: it has to run whatever the app
 * renders first, an error boundary's fallback included, or a console that failed to start would be
 * covered for good.
 */
export function ConsoleReveal() {
  useLayoutEffect(() => {
    const html = document.documentElement;
    const timers: ReturnType<typeof setTimeout>[] = [];
    let frame = 0;
    let finished = false;

    // Everything the wait changed, put back in one step: no cover, the ground where the page was
    // clear for the window's drawing, no lockup behind the console. Once.
    const finish = () => {
      if (finished) return;
      finished = true;
      html.removeAttribute(REVEAL_ATTRIBUTE);
      html.removeAttribute(SHELL_ATTRIBUTE);
      document.querySelector('.boot-lockup')?.remove();

      // Two frames: the first callback runs before its frame is painted, the second after. The
      // Windows window stops drawing its lockup on this, and must not while it is still on screen.
      const host = webview();
      if (host) frame = requestAnimationFrame(() => (frame = requestAnimationFrame(() => host.postMessage(CONSOLE_DRAWN))));
    };

    html.setAttribute(REVEAL_ATTRIBUTE, 'covered');

    // One frame first, so the console has been laid out and has asked for its faces; `ready` read
    // before that resolves at once, with nothing yet loading. Then the faces, but not for ever: a
    // face that never arrives is a console set in a fallback, which beats one that never opens.
    frame = requestAnimationFrame(() => {
      const faces = document.fonts?.ready ?? Promise.resolve();
      const capped = new Promise((done) => timers.push(setTimeout(done, FACES_CAP_MS)));
      void Promise.race([faces, capped]).then(finish);
    });

    // StrictMode runs this twice in development: undo the first run's waiting, not its effects.
    return () => {
      finished = true;
      cancelAnimationFrame(frame);
      timers.forEach(clearTimeout);
    };
  }, []);

  return null;
}

type WebView = { postMessage(message: unknown): void };

/** The WebView2 host, if this page is running in one — see shell.ts. */
function webview(win: Window = window): WebView | undefined {
  return (win as Window & { chrome?: { webview?: WebView } }).chrome?.webview;
}
