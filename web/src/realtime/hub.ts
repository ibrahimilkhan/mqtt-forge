import * as signalR from '@microsoft/signalr';
import type { ConnectionStateResponse, MqttMessage } from '../types/api';

export type HubEvents = {
  // Batched server-side: a busy broker outruns one frame per message.
  messagesReceived: (messages: MqttMessage[]) => void;
  connectionStateChanged: (payload: ConnectionStateResponse) => void;
  /** Running total the server's own queue has had to drop, sent only when it moves. */
  messagesDropped: (total: number) => void;
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

  // onclose fires when withAutomaticReconnect exhausts its schedule, and start() rejects when the
  // API is not up yet; retry by hand in both cases so the hub still recovers.
  connection.onclose(() => {
    notifyReconnecting();
    retryUntilConnected();
  });

  // One loop at a time. Both paths above can answer for the same failure, and two loops racing
  // means the loser calls start() on a connection the winner has already brought up — which
  // rejects with 'not in the Disconnected state' and so schedules another try, and another, every
  // five seconds for as long as the page is open. The flag is what makes the second caller a
  // no-op rather than a second retrier.
  let retrying = false;

  function retryUntilConnected(): void {
    if (retrying) return;

    retrying = true;
    attempt();
  }

  function attempt(): void {
    connection.start().then(() => {
      retrying = false;
      notifyReconnected();
    }, () => setTimeout(attempt, MANUAL_RETRY_DELAY_MS));
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

      if (handlers.messagesDropped) {
        const handler = handlers.messagesDropped;
        connection.on('messagesDropped', handler);
        registered.push(() => connection.off('messagesDropped', handler));
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
