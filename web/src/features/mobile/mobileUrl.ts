import { networkUrl } from 'virtual:network-url';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

type MobileUrl =
  /** An address another device can actually open. */
  | { kind: 'reachable'; url: string }
  /** All we know is a loopback address, which is useless on a phone. */
  | { kind: 'loopback'; url: string };

/**
 * Works out which address to put in the QR code. The dev server tells us its network
 * address through the virtual module; a production build has no such hint, but there the
 * page was already fetched over the address the phone needs, so the origin is right —
 * unless it was opened on loopback, which the caller has to explain rather than encode.
 */
export function resolveMobileUrl(
  hint: string | null = networkUrl,
  origin: { origin: string; hostname: string } = window.location,
): MobileUrl {
  if (hint) return { kind: 'reachable', url: hint };
  const kind = LOOPBACK.has(origin.hostname) ? 'loopback' : 'reachable';
  return { kind, url: `${origin.origin}/` };
}
