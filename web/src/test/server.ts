import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

// Quiet defaults for the three GETs any mounted panel makes, so a test only has to state
// what it actually cares about. Anything else is a mistake worth failing on rather than
// silently reaching the network.
const defaultHandlers = [
  http.get('/api/connection', () => HttpResponse.json({ state: 'Disconnected' })),
  http.get('/api/connection/settings', () => new HttpResponse(null, { status: 204 })),
  http.get('/api/subscriptions', () => HttpResponse.json([])),
  http.get('/api/health', () => HttpResponse.json({ status: 'ok' })),
];

export const server = setupServer(...defaultHandlers);
