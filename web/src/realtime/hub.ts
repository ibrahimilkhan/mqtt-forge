import * as signalR from '@microsoft/signalr';
import type { ConnectionStateResponse, MqttMessage } from '../types/api';

export type HubEvents = {
  messageReceived: (message: MqttMessage) => void;
  connectionStateChanged: (payload: ConnectionStateResponse) => void;
  reconnecting: () => void;
  reconnected: () => void;
};

export interface Hub {
  start(): Promise<void>;
  // Returns the function that removes these handlers again.
  subscribe(handlers: Partial<HubEvents>): () => void;
}

// How long to wait between manual reconnect attempts once withAutomaticReconnect has
// given up on its own schedule (about 30 seconds).
const MANUAL_RETRY_DELAY_MS = 5000;

// The live stream connection. It is created once at module scope rather than inside a
// component, so StrictMode's double mount cannot open two connections to the hub.
export function createSignalRHub(url = '/hubs/mqtt'): Hub {
  const connection = new signalR.HubConnectionBuilder().withUrl(url).withAutomaticReconnect().build();

  let started: Promise<void> | undefined;
  const reconnectingHandlers = new Set<() => void>();
  const reconnectedHandlers = new Set<() => void>();
  const notifyReconnecting = () => reconnectingHandlers.forEach((handler) => handler());
  const notifyReconnected = () => reconnectedHandlers.forEach((handler) => handler());

  // withAutomaticReconnect only retries a drop for its own schedule, then calls onclose
  // instead of onreconnected; a dead-on-arrival first start also lands here without ever
  // reaching onreconnecting. Both cases keep retrying by hand so the hub actually recovers
  // once the API comes back, instead of sitting closed while the UI still says reconnecting.
  connection.onclose(() => {
    notifyReconnecting();
    retryUntilConnected();
  });

  function retryUntilConnected(): void {
    connection.start().then(notifyReconnected, () => setTimeout(retryUntilConnected, MANUAL_RETRY_DELAY_MS));
  }

  return {
    start() {
      started ??= connection.start().catch((error: unknown) => {
        notifyReconnecting();
        retryUntilConnected();
        throw error;
      });
      return started;
    },

    subscribe(handlers) {
      const registered: Array<() => void> = [];

      if (handlers.messageReceived) {
        const handler = handlers.messageReceived;
        connection.on('messageReceived', handler);
        registered.push(() => connection.off('messageReceived', handler));
      }

      if (handlers.connectionStateChanged) {
        const handler = handlers.connectionStateChanged;
        connection.on('connectionStateChanged', handler);
        registered.push(() => connection.off('connectionStateChanged', handler));
      }

      // signalR offers no way to remove lifecycle handlers; the connection outlives the
      // app, so there is nothing to clean up for these two.
      if (handlers.reconnecting) {
        const handler = handlers.reconnecting;
        connection.onreconnecting(() => handler());
        reconnectingHandlers.add(handler);
        registered.push(() => reconnectingHandlers.delete(handler));
      }

      if (handlers.reconnected) {
        const handler = handlers.reconnected;
        connection.onreconnected(() => handler());
        reconnectedHandlers.add(handler);
        registered.push(() => reconnectedHandlers.delete(handler));
      }

      return () => registered.forEach((remove) => remove());
    },
  };
}

export const hub = createSignalRHub();
