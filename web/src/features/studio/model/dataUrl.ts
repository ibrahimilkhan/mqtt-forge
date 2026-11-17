const DATA_URL = /^data:([^;,]+)?;base64,(.*)$/s;

/**
 * A DesignBox model carried inline as a base64 data url, as bytes again. Decoded by hand rather
 * than through fetch(), which would put a file of tens of megabytes through the network layer to
 * get it back out.
 */
export function dataUrlToBlob(url: string): { blob: Blob; mime: string } {
  const match = url.match(DATA_URL);
  if (!match) throw new Error('Not a base64 data url.');

  const mime = match[1] ?? 'application/octet-stream';
  const text = atob(match[2]);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);

  return { blob: new Blob([bytes], { type: mime }), mime };
}
