import { hostname } from 'node:os';
import type { Plugin, ViteDevServer } from 'vite';

const ID = 'virtual:network-url';
const RESOLVED = `\0${ID}`;

/**
 * Exposes the address this machine is reachable at from other devices, so the panel can
 * offer it as a QR code. The browser cannot work this out for itself: whoever opens the
 * panel is usually on localhost, and a QR of localhost is useless on a phone.
 *
 * Resolves to null outside the dev server — a production build is served by the API, so the
 * page is already loaded over whatever address the phone would need, and window.location
 * is the better answer there.
 */
export function networkUrl(): Plugin {
  let server: ViteDevServer | undefined;

  return {
    name: 'mqfaker:network-url',
    configureServer(created) {
      server = created;
    },
    resolveId(id) {
      return id === ID ? RESOLVED : undefined;
    },
    load(id) {
      if (id !== RESOLVED) return undefined;
      // Loading happens on browser request, which is necessarily after listen, so
      // resolvedUrls is populated by the time this runs.
      return `export const networkUrl = ${JSON.stringify(pick(server))};`;
    },
  };
}

function pick(server: ViteDevServer | undefined): string | null {
  const [first] = server?.resolvedUrls?.network ?? [];
  if (!first) return null;

  // The Bonjour name is friendlier to read off a screen than a numeric address and it
  // survives a DHCP lease change, so prefer it when the machine advertises one. The
  // certificate covers both names, so swapping the host keeps HTTPS working.
  const bonjour = hostname();
  if (!bonjour.endsWith('.local')) return first;

  const url = new URL(first);
  url.hostname = bonjour;
  return url.toString();
}
