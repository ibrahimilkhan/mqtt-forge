import { describe, expect, it } from 'vitest';
import { dataUrlToBlob } from './dataUrl';

describe('dataUrlToBlob', () => {
  it('decodes a base64 data url into its bytes and type', async () => {
    const { blob, mime } = dataUrlToBlob('data:model/stl;base64,c29saWQ=');
    expect(mime).toBe('model/stl');
    expect(await blob.text()).toBe('solid');
  });

  it('refuses anything that is not a base64 data url', () => {
    expect(() => dataUrlToBlob('https://example.com/a.stl')).toThrow();
  });
});
