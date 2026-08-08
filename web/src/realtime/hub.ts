import * as signalR from '@microsoft/signalr';
import type { ConnectionStateResponse, MqttMessage } from '../types/api';

export type HubEvents = {
  // Batched server-side: a busy broker outruns one frame per message.
  messagesReceived: (messages: MqttMessage[]) => void;
  connectionStateChanged: (payload: ConnectionStateResponse) => void;
  reconnecting: () => void;
  reconnected: () => void;
};

export interface Hub {
  start(): Promise<void>;
  // Returns an unsubscribe function.
  subscribe(handlers: Partial<HubEvents>): () => void;
}

// Retry interval once withAutomaticReconnect gives up on its own schedule (~30s).
const MANUAL_RETRY_DELAY_MS = 5000;

// Factory, not the singleton — do not call this from a component; use the exported hub below.
export function createSignalRHub(url = '/hubs/mqtt'): Hub {
  const connection = new signalR.HubConnectionBuilder().withUrl(url).withAutomaticReconnect().build();

  let started: Promise<void> | undefined;
  const reconnectingHandlers = new Set<() => void>();
  const reconnectedHandlers = new Set<() => void>();
  const notifyReconnecting = () => reconnectingHandlers.forEach((handler) => handler());
  const notifyReconnected = () => reconnectedHandlers.forEach((handler) => handler());

  // onclose fires both when withAutomaticReconnect exhausts its schedule and on a
  // dead-on-arrival first start; retry by hand in both cases so the hub still recovers.
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

      if (handlers.messagesReceived) {
        const handler = handlers.messagesReceived;
        connection.on('messagesReceived', handler);
        registered.push(() => connection.off('messagesReceived', handler));
      }

      if (handlers.connectionStateChanged) {
        const handler = handlers.connectionStateChanged;
        connection.on('connectionStateChanged', handler);
        registered.push(() => connection.off('connectionStateChanged', handler));
      }

      // signalR has no lifecycle-handler removal API; harmless since the connection outlives the app.
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

// Module-scope singleton so StrictMode's double mount can't open two connections.
export const hub = createSignalRHub();
