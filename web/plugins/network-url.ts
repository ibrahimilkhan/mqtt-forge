import { hostname } from 'node:os';
import type { Plugin, ViteDevServer } from 'vite';

const ID = 'virtual:network-url';
const RESOLVED = `\0${ID}`;

// LAN address for the phone's QR code, since the browser only knows it's on localhost.
// Null outside dev — production is served by the API, so window.location has the real address.
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
      // Runs after listen, so resolvedUrls is already populated.
      return `export const networkUrl = ${JSON.stringify(pick(server))};`;
    },
  };
}

function pick(server: ViteDevServer | undefined): string | null {
  const [first] = server?.resolvedUrls?.network ?? [];
  if (!first) return null;

  // Prefer the Bonjour name: readable, DHCP-stable, and covered by the cert too.
  const bonjour = hostname();
  if (!bonjour.endsWith('.local')) return first;

  const url = new URL(first);
  url.hostname = bonjour;
  return url.toString();
}
