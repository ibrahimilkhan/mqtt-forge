import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Not `new URL('..', import.meta.url)`: Vite rewrites that literal pattern to an asset URL under Vitest.
const SRC = dirname(dirname(fileURLToPath(import.meta.url)));
const fonts = readFileSync(join(SRC, 'styles/fonts.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');
const page = readFileSync(join(dirname(SRC), 'index.html'), 'utf8');

/**
 * The faces the console is set in are asked for before the console is.
 *
 * `font-display: swap` means text is drawn at once in a fallback and redrawn when the face arrives,
 * and a face is only asked for once some text that needs it has been laid out — which, for a
 * console React draws, is after the bundle has been parsed and run. Measured on the desktop window
 * with an empty cache: the console's first frame at 119ms in Segoe UI and Consolas, Inter and
 * JetBrains Mono at 164ms, and every line of type moving sideways as they landed. Preloaded, they
 * are on their way while the bundle is, and the console's first frame is set in them.
 *
 * Only the Latin cut of each: it is the one every line of the console needs, and a preload that
 * goes unused is a warning in the console and a download for nothing. The extended cuts load the
 * way they always have, when a character in their range turns up.
 */
describe('the faces the console is set in', () => {
  const latin = [...fonts.matchAll(/@font-face\s*\{([^}]*)\}/g)]
    .map(([, body]) => body)
    .filter((body) => /unicode-range:\s*U\+0000-00FF/.test(body))
    .map((body) => /src:\s*url\('([^']+)'\)/.exec(body)![1]);

  it('has a Latin cut of each family to preload', () => {
    expect(latin).toEqual(['/fonts/inter-latin.woff2', '/fonts/jetbrains-mono-latin.woff2']);
  });

  it.each(latin)('asks for %s before anything needs it', (href) => {
    const link = [...page.matchAll(/<link\b[^>]*>/g)].map(([tag]) => tag).find((tag) => tag.includes(`href="${href}"`));

    expect(link, `index.html has no preload for ${href}`).toBeDefined();
    expect(link).toMatch(/rel="preload"/);
    expect(link).toMatch(/as="font"/);
    expect(link).toMatch(/type="font\/woff2"/);
    // Fonts are always fetched in CORS mode, same origin or not; a preload without this is a second
    // request the real one cannot use.
    expect(link).toMatch(/\bcrossorigin\b/);
  });
});
