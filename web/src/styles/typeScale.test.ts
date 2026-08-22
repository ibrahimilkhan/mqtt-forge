import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULTS, MONO, SANS } from '../features/appearance/fonts.js';

// Not `new URL('..', import.meta.url)`: Vite statically rewrites that literal pattern to
// an asset URL, which resolves against localhost under Vitest, not the filesystem.
const SRC = dirname(dirname(fileURLToPath(import.meta.url)));

function cssFiles(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.css'))
    .map((entry) => join(SRC, entry));
}

// Matches `font-size` and a px size inside the `font` shorthand, case-insensitively.
const FONT_SIZE_PX = /font(?:-size)?:[^;}]*?\b[\d.]+px/gi;

// A px font-size can't be scaled by the appearance panel, so only tokens.css may declare one.
describe('type scale', () => {
  it('declares no px font-size outside tokens.css', () => {
    const offenders = cssFiles()
      .filter((file) => !file.endsWith('tokens.css'))
      .flatMap((file) => {
        const found = readFileSync(file, 'utf8').match(FONT_SIZE_PX) ?? [];
        return found.map((declaration) => `${file}: ${declaration}`);
      });

    expect(offenders).toEqual([]);
  });

  it('finds the css files it is meant to police', () => {
    expect(cssFiles().length).toBeGreaterThan(5);
  });

  it('keeps tokens.css in step with the catalogue defaults', () => {
    const tokens = readFileSync(join(SRC, 'styles/tokens.css'), 'utf8');
    expect(tokens).toContain(`--sans: ${SANS[DEFAULTS.sans].stack}`);
    expect(tokens).toContain(`--mono: ${MONO[DEFAULTS.mono].stack}`);
  });

  it('defines exactly the 8 rem-based type tokens the design table specifies', () => {
    const tokens = readFileSync(join(SRC, 'styles/tokens.css'), 'utf8');
    const declarations = [...tokens.matchAll(/--t-([\w-]+):\s*([^;]+);/g)].map(([, name, rawValue]) => ({
      name,
      rawValue: rawValue.trim(),
    }));

    expect(declarations).toHaveLength(8);

    const REM = /^([\d.]+)rem$/;
    for (const { rawValue } of declarations) {
      expect(rawValue).toMatch(REM);
    }

    const remValueOf = (name: string) => Number(declarations.find((d) => d.name === name)!.rawValue.match(REM)![1]);

    const BASE = 15;
    // px column is rounded intent (e.g. 0.767 * 15 = 11.505), so allow a small tolerance.
    const expectedPxAt15: Record<string, number> = {
      // The step under micro, for the one line in the console smaller than an address: the
      // heading over a group of panel buttons in the rail.
      nano: 10,
      micro: 10.5,
      label: 11.5,
      small: 12.75,
      code: 13.5,
      body: 15,
      lead: 17,
      title: 19,
    };

    for (const [name, expectedPx] of Object.entries(expectedPxAt15)) {
      expect(Math.abs(remValueOf(name) * BASE - expectedPx)).toBeLessThan(0.01);
    }
  });
});
