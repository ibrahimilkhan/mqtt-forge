/**
 * The handshake between the console and the Windows desktop window it can be hosted in.
 *
 * On Windows the desktop app draws the startup lockup itself, natively, from the moment its
 * window appears — the browser inside it takes a second and a half to be able to draw anything.
 * Two drawings of the same lockup, one handing over to the other, meant the name jumped a pixel or
 * two at the hand-off: GDI+ and the browser set the same type in slightly different places and
 * shapes, and at 125% no amount of arithmetic lines them up. So on Windows there is one drawing
 * for the whole of startup. The browser draws no lockup and no ground until the console itself is
 * drawn, and says when that has happened, and the window stops drawing its own then.
 *
 * `window.chrome.webview` is how the page knows it is inside WebView2 — which, for this app, is
 * the Windows desktop window and nothing else. A browser has `window.chrome` but not `webview`; the
 * macOS and Linux windows are WebKit and have neither, and keep the page's own lockup.
 *
 * The strings are shared with src/MqttForge.Desktop (Splash.ConsoleDrawn) and with
 * web/plugins/boot-lockup.ts; each side has a test pinning them. Nothing in this file touches the
 * DOM, because the plugin imports it and is type-checked under Node, which has no `Window`.
 */

/** Set on <html> by index.html's first script, before anything paints, when hosted in WebView2. */
export const SHELL_ATTRIBUTE = 'data-shell';
export const SHELL_WEBVIEW = 'webview';

/** Sent to the window once the console is on screen in place of the lockup. */
export const CONSOLE_DRAWN = 'console-painted';

/**
 * Set on <html> — `covered` — from the console's first commit until what its first frame needs is
 * ready, while the lockup is what is on screen. See ConsoleReveal.
 */
export const REVEAL_ATTRIBUTE = 'data-reveal';

/**
 * The prefix of a message asking the desktop window to take a title — the rest of the message is
 * the title. src/MqttForge.Desktop/WindowTitle.cs reads it, and pins the string from its side.
 */
export const WINDOW_TITLE = 'window-title:';
