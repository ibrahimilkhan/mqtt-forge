import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { server } from './server';
import { useBrokerEventsStore } from '../stores/brokerEventsStore';
import { resetLinkWatch } from '../stores/linkWatchStore';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));

// Needed because globals are off, so Testing Library's own auto-cleanup never registers.
afterEach(() => {
  cleanup();
  server.resetHandlers();
  // See resetLinkWatch: a session's worth of link history outliving one test changes what the
  // next test's Broker panel draws.
  resetLinkWatch();
  // Same reason: the events beside the Broker form are never cleared by a connection, so one
  // test's drops would be read by the next test's panel.
  useBrokerEventsStore.getState().clear();
});

afterAll(() => server.close());
