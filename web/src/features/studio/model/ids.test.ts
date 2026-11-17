import { describe, expect, it } from 'vitest';
import { newId } from './ids';

describe('newId', () => {
  it('is sixteen hex characters, a safe scene id, and does not repeat', () => {
    const ids = new Set(Array.from({ length: 1000 }, newId));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{16}$/);
  });
});
