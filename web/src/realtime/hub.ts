import * as signalR from '@microsoft/signalr';
import type { AlertDto, ConnectionStateResponse, MqttMessage, ReconnectStatus } from '../types/api';

export type HubEvents = {
  // Batched server-side: a busy broker outruns one frame per message.
  messagesReceived: (messages: MqttMessage[]) => void;
  connectionStateChanged: (payload: ConnectionStateResponse) => void;
  /**
   * What the supervisor is doing about a link that dropped, sent only when it changes.
   *
   * Its own event rather than more fields on the payload above: that one is the whole picture of
   * the link, and a console folding them together would re-read the link every time a countdown
   * moved on a rung.
   */
  reconnectStatusChanged: (status: ReconnectStatus) => void;
  /** Running total the server's own queue has had to drop, sent only when it moves. */
  messagesDropped: (total: number) => void;
  /** Alarms that have just started. Batched at five hundred: a restart can restore a thousand. */
  alertsRaised: (alerts: AlertDto[]) => void;
  /** Alarms that have just stopped, carrying the resolvedAt and resolvedBy the active copy lacks. */
  alertsResolved: (alerts: AlertDto[]) => void;
  /**
   * A (rule, topic) pair silenced, and the moment it speaks again. Null is the lift.
   *
   * Three arguments rather than one object because that is what the endpoint sends, and the pair
   * rather than an alert id because a mute outlives the alarm it was set on.
   */
  alertMuted: (ruleId: string, topic: string, until: string | null) => void;
  /** Running total of what the alert engine never judged, sent only when it moves. */
  alertsDropped: (total: number) => void;
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

      /**
       * Binds one server-sent event, if this caller asked for it, and remembers how to unbind it.
       *
       * Eight of these now, and each used to be the same four lines with the same name written in
       * three places — which is exactly the shape a new event gets added to by copying and then
       * forgetting one of the three. The lifecycle pair below cannot join it: signalR has no
       * removal API for onreconnecting and onreconnected, so those are kept in sets of our own.
       */
      const bind = <K extends keyof HubEvents>(event: K) => {
        const handler = handlers[event];
        if (!handler) return;

        connection.on(event, handler);
        registered.push(() => connection.off(event, handler));
      };

      bind('messagesReceived');
      bind('connectionStateChanged');
      bind('reconnectStatusChanged');
      bind('messagesDropped');
      bind('alertsRaised');
      bind('alertsResolved');
      bind('alertMuted');
      bind('alertsDropped');

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
