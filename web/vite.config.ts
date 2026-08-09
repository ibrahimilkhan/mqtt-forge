import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { networkUrl } from './plugins/network-url.ts';

// Phone testing needs HTTPS (secure-context APIs); cert is per-machine and gitignored, so HTTPS is opt-in.
const certDirectory = fileURLToPath(new URL('./certs/', import.meta.url));
const key = `${certDirectory}dev-key.pem`;
const cert = `${certDirectory}dev-cert.pem`;
const https =
  existsSync(key) && existsSync(cert)
    ? { key: readFileSync(key), cert: readFileSync(cert) }
    : undefined;

export default defineConfig({
  plugins: [react(), networkUrl()],
  server: {
    // Exposes the dev server on the LAN, not just localhost.
    host: true,
    https,
    // Proxy avoids CORS by keeping the browser on one origin; ws needed for SignalR.
    // Targets stay on localhost — the API only listens there, host:true just exposes Vite.
    proxy: {
      '/api': 'http://localhost:5169',
      '/hubs': { target: 'http://localhost:5169', ws: true },
    },
  },
  build: {
    // API serves the built site from its own wwwroot.
    outDir: '../src/MqttForge.Api/wwwroot',
    // outDir sits outside the Vite root, so Vite won't auto-clean it; force it or stale hashed assets pile up.
    emptyOutDir: true,
  },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/test/setup.ts'],
    css: true,
  },
});
