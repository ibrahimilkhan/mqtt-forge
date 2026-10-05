import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';
import { SHELL_ATTRIBUTE, SHELL_WEBVIEW } from '../src/features/shell/shell.ts';

/**
 * Puts the mark and the name beside #root, so the page wears them until the console is laid over.
 *
 * The desktop app opens on a splash of its own and then navigates here. This document paints its
 * ground as soon as its stylesheet arrives, and React draws nothing until the bundle has been parsed
 * and run — measured at 150 to 260ms on the machine this was written for. In that gap the reader saw
 * the lockup vanish to a bare ground and then the console appear, which reads as a flicker. The same
 * lockup here, in the same place, makes the hand-off invisible. It stands just before #root, not
 * inside it: React's first render would take it away, and the console is held out of sight until
 * its first frame is the right one (src/features/shell/ConsoleReveal), which takes the lockup away
 * in the same step as it shows the console, so it costs the running console nothing. A browser opening
 * the web build gets the same thing while the bundle loads, which it did not have before either.
 *
 * Except in the Windows desktop window, which draws the lockup natively for the whole of startup
 * and has this page stay clear over it instead — see src/features/shell/shell.ts and the rules for
 * a hosted page below. What is said here holds for the macOS window and for a browser.
 *
 * The mark is read from public/favicon.svg, which brand/marks.tsx names as the drawing every copy is
 * cut from, and inlined rather than linked: an <img> is a request the first paint does not wait for.
 * The layout is src/MqttForge.Desktop/Splash.cs's, value for value — change one and the other, or
 * the mark moves at the moment one document replaces the other.
 */
export function bootLockup(faviconPath: string): Plugin {
  return {
    name: 'mqttforge:boot-lockup',
    // Read on every transform rather than once, so editing the favicon under the dev server shows.
    transformIndexHtml: (html) => withLockup(html, readFileSync(faviconPath, 'utf8')),
  };
}

const HOSTED = `html[${SHELL_ATTRIBUTE}='${SHELL_WEBVIEW}']`;

// Fixed to the viewport so none of the body's padding or flex layout reaches it — it has to land on
// exactly the pixels the desktop splash put it on. Behind everything (z-index -1, over the canvas's
// ground and under #root's content) because it stays in the page while the console is laid out
// in front of it; see ConsoleReveal, which removes it as the console is shown. The ground is not set here:
// global.css paints the body --paper, and this stylesheet cannot paint before that one has arrived.
const STYLE =
  '<style>' +
  '.boot-lockup{position:fixed;inset:0;z-index:-1;display:flex;flex-direction:column;align-items:center;' +
  'justify-content:center;gap:20px}' +
  '.boot-lockup svg{width:76px;height:76px;display:block}' +
  '.boot-lockup p{margin:0;font:600 22px/1.25 ui-monospace,Consolas,Menlo,monospace;' +
  'letter-spacing:-.03em;color:#6b7480;position:relative}' +
  // The loading line: a track under the name with a stretch of it flowing along, so a lockup that
  // is up for more than a moment reads as a start rather than a hang. Absolutely placed off the name
  // so the column, and so the mark and the name, stand exactly where they did without it. The
  // stretch runs from wholly off the left end to wholly off the right: at 35% of the track, that is
  // background-position -53.85% to 153.85%. Its phase comes from the wall clock (the script below),
  // which is what lets the macOS splash hand over to this page mid-flow rather than restarting it.
  // The numbers are Splash.cs's Flow* constants; its tests and these pin both.
  ".boot-lockup p::after{content:'';position:absolute;left:50%;top:calc(100% + 18px);width:112px;height:2px;" +
  'margin-left:-56px;border-radius:1px;background:#d2d8e2 linear-gradient(#0e4260,#0e4260) no-repeat;' +
  'background-size:35% 100%;animation:boot-flow 1400ms cubic-bezier(.45,0,.55,1) var(--flow-delay,0ms) infinite}' +
  '@keyframes boot-flow{from{background-position:-53.85% 0}to{background-position:153.85% 0}}' +
  '.boot-lockup span{color:#0e4260}' +
  // Hosted in the Windows desktop window, the window draws this lockup itself for the whole of
  // startup, and a second drawing here would hand over to it with the name a pixel or two off
  // (src/features/shell/shell.ts). So a hosted page draws no lockup and no ground — WebView2 is
  // told to show the window through wherever a page paints nothing — until the console has been
  // on screen, when ConsoleReveal takes the attribute away and global.css's ground comes back with
  // it.
  `${HOSTED},${HOSTED} body{background:transparent}` +
  `${HOSTED} .boot-lockup{display:none}` +
  '</style>';

// Before anything else in the page, and inline: it has to have run by the first paint, which the
// stylesheet holds back but a module script does not wait for. Two things: where the loading line
// is in its period, by the wall clock, and whether the page is hosted in the Windows window.
const MARK_HOSTED =
  `<script>document.documentElement.style.setProperty('--flow-delay',-(Date.now()%1400)+'ms');` +
  `if(window.chrome&&window.chrome.webview)` +
  `document.documentElement.setAttribute('${SHELL_ATTRIBUTE}','${SHELL_WEBVIEW}')</script>`;

const ROOT = '<div id="root"></div>';

export function withLockup(html: string, favicon: string): string {
  if (!html.includes(ROOT)) throw new Error(`index.html has no empty #root (${ROOT}) to put the lockup in`);

  const mark = inline(favicon);
  // aria-hidden: the name is already the page's title, and this is gone before anyone could use it.
  const lockup = `<div class="boot-lockup" aria-hidden="true">${mark}<p>MQTT<span>Forge</span></p></div>`;

  return html
    .replace('</head>', `${MARK_HOSTED}${STYLE}</head>`)
    .replace(ROOT, `${lockup}${ROOT}`);
}

// The same two changes Splash.Inline makes on the desktop: the namespace goes, because inline SVG in
// HTML does not need it, and the whitespace between tags goes, because it is a third of the file.
function inline(svg: string): string {
  const start = svg.indexOf('<svg');
  if (start < 0) throw new Error('favicon.svg has no <svg> element');

  return svg
    .slice(start)
    .replace(/\s+xmlns(:\w+)?\s*=\s*"[^"]*"/g, '')
    .replace(/>\s+</g, '><')
    .trim();
}
