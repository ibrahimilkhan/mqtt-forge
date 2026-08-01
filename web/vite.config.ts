import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Testing on a phone means serving over the LAN address rather than localhost, and the
// browser APIs the panel relies on are only handed out in a secure context. The cert is
// generated per machine and left out of the repository, so HTTPS stays opt-in: without it
// the dev server falls back to plain HTTP and nothing else has to change. See web/README.
const certDirectory = fileURLToPath(new URL('./certs/', import.meta.url));
const key = `${certDirectory}dev-key.pem`;
const cert = `${certDirectory}dev-cert.pem`;
const https =
  existsSync(key) && existsSync(cert)
    ? { key: readFileSync(key), cert: readFileSync(cert) }
    : undefined;

export default defineConfig({
  plugins: [react()],
  server: {
    // Binding to every interface is what puts the dev server on the LAN address; localhost
    // keeps working alongside it.
    host: true,
    https,
    // The API is a separate process in development. Proxying keeps the browser on one
    // origin, so CORS never enters the picture; ws is required by the SignalR transport.
    // The proxy runs on this machine, so the API itself stays bound to localhost.
    proxy: {
      '/api': 'http://localhost:5169',
      '/hubs': { target: 'http://localhost:5169', ws: true },
    },
  },
  build: {
    // The API serves the built site from its own wwwroot, so one process and one port is
    // all a user needs. emptyOutDir is required because the directory sits outside the
    // Vite root.
    outDir: '../src/MQFaker.Api/wwwroot',
    emptyOutDir: true,
  },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/test/setup.ts'],
    css: true,
  },
});
