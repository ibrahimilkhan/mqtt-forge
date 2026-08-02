import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { server } from './server';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));

// Needed because globals are off, so Testing Library's own auto-cleanup never registers.
afterEach(() => {
  cleanup();
  server.resetHandlers();
});

afterAll(() => server.close());
