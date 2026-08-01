import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULTS, MONO, SANS } from '../features/appearance/fonts.js';

// Not `fileURLToPath(new URL('..', import.meta.url))`: Vite statically rewrites the
// literal `new URL('...', import.meta.url)` pattern into an asset-URL resolution, which
// under Vitest's dev-server transform resolves against http://localhost, not the
// filesystem. Two dirname() calls land on the same directory (src/) without tripping it.
const SRC = dirname(dirname(fileURLToPath(import.meta.url)));

function cssFiles(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.css'))
    .map((entry) => join(SRC, entry));
}

// Matches both the `font-size` longhand and a px size riding inside the `font` shorthand
// (e.g. `font: 600 14px/1.2 var(--mono)`), case-insensitively so `14PX` cannot slip through.
const FONT_SIZE_PX = /font(?:-size)?:[^;}]*?\b[\d.]+px/gi;

// A px font-size cannot be scaled by the appearance panel, so tokens.css is the only
// file allowed to name one: it holds the scale and the root base the scale hangs off.
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

  it('defines exactly the 7 rem-based type tokens the design table specifies', () => {
    const tokens = readFileSync(join(SRC, 'styles/tokens.css'), 'utf8');
    const declarations = [...tokens.matchAll(/--t-([\w-]+):\s*([^;]+);/g)].map(([, name, rawValue]) => ({
      name,
      rawValue: rawValue.trim(),
    }));

    expect(declarations).toHaveLength(7);

    const REM = /^([\d.]+)rem$/;
    for (const { rawValue } of declarations) {
      expect(rawValue).toMatch(REM);
    }

    const remValueOf = (name: string) => Number(declarations.find((d) => d.name === name)!.rawValue.match(REM)![1]);

    const BASE = 15;
    // The design table's px column is the rounded intent — 0.767 * 15 = 11.505 and
    // 1.133 * 15 = 16.995 and 1.267 * 15 = 19.005 — so compare with a small tolerance
    // instead of exact equality.
    const expectedPxAt15: Record<string, number> = {
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
