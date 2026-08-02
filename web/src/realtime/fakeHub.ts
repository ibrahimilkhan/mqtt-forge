import type { HubEvents } from './hub';

// Lets tests emit hub events without a real SignalR server.
export function createFakeHub() {
  const handlerSets: Array<Partial<HubEvents>> = [];

  const fake = {
    startCount: 0,

    start() {
      fake.startCount += 1;
      return Promise.resolve();
    },

    subscribe(handlers: Partial<HubEvents>) {
      handlerSets.push(handlers);
      return () => {
        const index = handlerSets.indexOf(handlers);
        if (index >= 0) handlerSets.splice(index, 1);
      };
    },

    emit<K extends keyof HubEvents>(event: K, ...args: Parameters<HubEvents[K]>) {
      for (const handlers of [...handlerSets]) {
        (handlers[event] as ((...a: Parameters<HubEvents[K]>) => void) | undefined)?.(...args);
      }
    },
  };

  // Structurally a Hub, plus test-only handles (startCount, emit).
  return fake;
}
