import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SHELL_ATTRIBUTE, SHELL_WEBVIEW } from '../src/features/shell/shell.ts';
import { withLockup } from './boot-lockup.ts';

// Not `new URL('..', import.meta.url)`: Vite rewrites that literal pattern into an asset URL, the
// same trap src/styles/typeScale.test.ts steps around.
const WEB = dirname(dirname(fileURLToPath(import.meta.url)));

// The real favicon: the one drawing every copy of the mark is cut from (see brand/marks.tsx).
const favicon = readFileSync(join(WEB, 'public/favicon.svg'), 'utf8');
const page = readFileSync(join(WEB, 'index.html'), 'utf8');

describe('withLockup', () => {
  // The desktop app shows its splash, then navigates here, and this document paints its ground as
  // soon as the stylesheet lands — a couple of hundred milliseconds before React has drawn anything.
  // Measured: the lockup appeared, vanished to a bare ground, and then the console arrived. The same
  // lockup here keeps it on screen until the console is shown in its place.
  it('puts the lockup just before #root, and leaves #root for React', () => {
    const html = withLockup(page, favicon);
    const body = html.slice(html.indexOf('<body>'));

    // Beside #root rather than in it: React's first render would take it away, and the console is
    // held out of sight until its first frame is the right one (src/features/shell/ConsoleReveal),
    // so the lockup has to still be there meanwhile. ConsoleReveal takes it away as it shows it.
    expect(body).toMatch(/<div class="boot-lockup"[^>]*><svg[\s\S]*MQTT<span>Forge<\/span><\/p><\/div><div id="root"><\/div>/);
  });

  it('lies behind the console, which is laid over it', () => {
    // Positioned, it would paint over #root's content; under it, the console covers it the moment
    // it is shown.
    expect(withLockup(page, favicon)).toMatch(/\.boot-lockup\{[^}]*z-index:-1/);
  });

  it('draws the mark the favicon draws', () => {
    const html = withLockup(page, favicon);
    const firstPath = /d="[^"]+"/.exec(favicon)![0];

    expect(html).toContain(firstPath);
    expect(html).toContain('fill="#0e4260"');
  });

  it('inlines the mark rather than linking it', () => {
    // Inline SVG in HTML needs no namespace, and an <img> would be a request the first paint does
    // not wait for — a frame of ground with a hole where the mark should be.
    const html = withLockup(page, favicon);
    const lockup = html.slice(html.indexOf('<div class="boot-lockup"'), html.indexOf('<div id="root">'));

    expect(lockup).not.toContain('xmlns');
    expect(lockup).not.toContain('<img');
  });

  it('matches the desktop splash so the hand-off does not jump', () => {
    // src/MqttForge.Desktop/Splash.cs sets the same lockup on its own page. Every one of these is
    // a pixel the mark or the name would move by at the moment one document replaces the other.
    const html = withLockup(page, favicon);

    expect(html).toContain('width:76px;height:76px');
    expect(html).toContain('gap:20px');
    expect(html).toContain('font:600 22px/1.25 ui-monospace,Consolas,Menlo,monospace');
    expect(html).toContain('letter-spacing:-.03em');
    expect(html).toContain('color:#6b7480');
  });

  // Hosted in the Windows desktop window, the window draws the lockup itself for the whole of
  // startup (src/features/shell/shell.ts says why), so this page must draw neither the lockup nor
  // the ground over it until the console is drawn — and must know it is hosted before its first
  // paint, which is before any module has run.
  describe('in the Windows window', () => {
    const script = (html: string) => {
      const head = html.slice(0, html.indexOf('</head>'));
      const scripts = [...head.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
      expect(scripts).toHaveLength(1);
      return scripts[0];
    };

    const run = (html: string, win: object) => {
      const attributes = new Map<string, string>();
      const document = {
        documentElement: {
          setAttribute: (name: string, value: string) => attributes.set(name, value),
          style: { setProperty: (name: string, value: string) => attributes.set(name, value) },
        },
      };
      new Function('window', 'document', script(html))(win, document);
      attributes.delete('--flow-delay');
      return attributes;
    };

    it('marks the page as hosted from the first script in it', () => {
      const html = withLockup(page, favicon);

      expect(run(html, { chrome: { webview: {} } }).get(SHELL_ATTRIBUTE)).toBe(SHELL_WEBVIEW);
      // Chrome and Edge have `window.chrome` too; only WebView2 has `webview` on it.
      expect(run(html, { chrome: {} }).size).toBe(0);
      expect(run(html, {}).size).toBe(0);
    });

    it('marks it inline, where no request can stand in front of the first paint', () => {
      expect(script(withLockup(page, favicon))).not.toMatch(/src=|import/);
    });

    it('stays clear and draws no lockup of its own while hosted', () => {
      const html = withLockup(page, favicon);
      const hosted = `html[${SHELL_ATTRIBUTE}='${SHELL_WEBVIEW}']`;

      expect(html).toContain(`${hosted},${hosted} body{background:transparent}`);
      expect(html).toContain(`${hosted} .boot-lockup{display:none}`);
    });
  });

  // A still lockup for longer than a moment reads as a hang, so a line under the name with a stretch
  // of it flowing along — the same line, on the same numbers, as src/MqttForge.Desktop/Splash.cs
  // draws on the macOS splash and NativeLockup draws in the Windows window.
  describe('the loading line', () => {
    it('flows under the name, out of the column so nothing moves for it', () => {
      const html = withLockup(page, favicon);

      expect(html).toContain('.boot-lockup p{margin:0;font:600 22px/1.25');
      expect(html).toMatch(/\.boot-lockup p\{[^}]*position:relative/);
      expect(html).toContain('.boot-lockup p::after{content:\'\';position:absolute;left:50%;top:calc(100% + 18px);width:112px;height:2px');
      expect(html).toContain('background:#d2d8e2 linear-gradient(#0e4260,#0e4260)');
      expect(html).toContain('animation:boot-flow 1400ms');
    });

    it('starts where the wall clock has it, so the splash hands over mid-flow on macOS', () => {
      const html = withLockup(page, favicon);
      const head = html.slice(0, html.indexOf('</head>'));
      const code = /<script>([\s\S]*?)<\/script>/.exec(head)![1];
      const set = new Map<string, string>();
      const document = { documentElement: { setAttribute() {}, style: { setProperty: (n: string, v: string) => set.set(n, v) } } };

      const before = Date.now();
      new Function('window', 'document', code)({}, document);

      const delay = Number(/^(-\d+)ms$/.exec(set.get('--flow-delay')!)![1]);
      expect(-delay).toBeGreaterThanOrEqual(0);
      expect(-delay).toBeLessThan(1400);
      expect(Math.abs(-delay - (before % 1400)) % 1400).toBeLessThan(50);
    });
  });

  it('refuses a page it cannot find the root in', () => {
    // Failing the build beats shipping a page whose lockup silently went missing.
    expect(() => withLockup('<body></body>', favicon)).toThrow(/#root/);
  });
});
