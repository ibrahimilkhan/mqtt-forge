import { networkUrl } from 'virtual:network-url';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

type MobileUrl =
  /** An address another device can actually open. */
  | { kind: 'reachable'; url: string }
  /** Loopback only — useless on a phone. */
  | { kind: 'loopback'; url: string };

// Dev gives a network address via the virtual module. Production has none, but the page
// was already fetched over the phone-reachable address, so window.location's origin is
// right unless it's loopback — which the caller must handle, not this function.
export function resolveMobileUrl(
  hint: string | null = networkUrl,
  origin: { origin: string; hostname: string } = window.location,
): MobileUrl {
  if (hint) return { kind: 'reachable', url: hint };
  const kind = LOOPBACK.has(origin.hostname) ? 'loopback' : 'reachable';
  return { kind, url: `${origin.origin}/` };
}
