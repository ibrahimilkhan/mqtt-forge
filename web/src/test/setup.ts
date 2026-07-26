import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { server } from './server';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));

// Testing Library only registers its own cleanup when Vitest runs with globals enabled,
// and this project keeps globals off — without this, rendered trees pile up across tests.
afterEach(() => {
  cleanup();
  server.resetHandlers();
});

afterAll(() => server.close());
