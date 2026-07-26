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

// The live stream connection. It is created once at module scope rather than inside a
// component, so StrictMode's double mount cannot open two connections to the hub.
export function createSignalRHub(url = '/hubs/mqtt'): Hub {
  const connection = new signalR.HubConnectionBuilder().withUrl(url).withAutomaticReconnect().build();

  let started: Promise<void> | undefined;

  return {
    start() {
      started ??= connection.start();
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
      }

      if (handlers.reconnected) {
        const handler = handlers.reconnected;
        connection.onreconnected(() => handler());
      }

      return () => registered.forEach((remove) => remove());
    },
  };
}

export const hub = createSignalRHub();
