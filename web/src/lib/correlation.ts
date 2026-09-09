/**
 * Correlation data as something a reader can compare.
 *
 * It is bytes on the wire and arrives base64, because that is what a byte array becomes in JSON.
 * Nearly always those bytes spell a request id — `istek-42`, a UUID, a number — and showing that
 * as `aXN0ZWstNDI=` would make the reader decode it themselves to check it against the request
 * they sent. So it is read as text when the bytes are text, and as hex when they are not: a
 * console that shows bytes shows them the way the publish form takes them.
 */
export function correlationText(base64: string): string {
  const bytes = decode(base64);
  if (!bytes) return base64;

  try {
    const said = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // Control characters spell nothing: a run of them reads as a corrupt string rather than as
    // the bytes it is, and the hex is the honest answer.
    return CONTROL.test(said) ? hex(bytes) : said;
  } catch {
    return hex(bytes);
  }
}

const CONTROL = /\p{Cc}/u;

function decode(base64: string): Uint8Array | null {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    return bytes;
  } catch {
    // Not base64 at all. Whatever it is, the caller's own string is closer to the truth than a
    // decoder's exception.
    return null;
  }
}

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
