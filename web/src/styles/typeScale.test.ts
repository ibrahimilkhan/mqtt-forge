import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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

// A px font-size cannot be scaled by the appearance panel, so tokens.css is the only
// file allowed to name one: it holds the scale and the root base the scale hangs off.
describe('type scale', () => {
  it('declares no px font-size outside tokens.css', () => {
    const offenders = cssFiles()
      .filter((file) => !file.endsWith('tokens.css'))
      .flatMap((file) => {
        const found = readFileSync(file, 'utf8').match(/font-size:\s*[\d.]+px/g) ?? [];
        return found.map((declaration) => `${file}: ${declaration}`);
      });

    expect(offenders).toEqual([]);
  });

  it('finds the css files it is meant to police', () => {
    expect(cssFiles().length).toBeGreaterThan(5);
  });
});
