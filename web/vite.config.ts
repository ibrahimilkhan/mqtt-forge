import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // The API is a separate process in development. Proxying keeps the browser on one
    // origin, so CORS never enters the picture; ws is required by the SignalR transport.
    proxy: {
      '/api': 'http://localhost:5169',
      '/hubs': { target: 'http://localhost:5169', ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/test/setup.ts'],
    css: true,
  },
});
