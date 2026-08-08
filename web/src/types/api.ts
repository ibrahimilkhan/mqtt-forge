// Mirrors MQFaker.Api.Contracts; ASP.NET serialises camelCase.
export type ConnectionState = 'Disconnected' | 'Connecting' | 'Connected' | 'Faulted';

// Set only alongside Faulted, and only when the API could work out a cause. It names the
// broker too: the saved settings record the last SUCCESSFUL connect, so a failed attempt to
// somewhere else leaves nothing on this side to match it against.
export type BrokerFailure = {
  reason: string;
  host: string;
  port: number;
  clientId: string;
  useTls: boolean;
};

export type ConnectionStateResponse = {
  state: ConnectionState;
  failure?: BrokerFailure | null;
  alreadyConnected?: boolean;
};

export type HealthResponse = { status: string };

export type SavedConnection = {
  host: string;
  port: number;
  clientId: string;
  username: string | null;
  hasPassword: boolean;
  useTls: boolean;
};

export type ConnectRequest = {
  host: string;
  port: number;
  clientId: string;
  username: string | null;
  password: string | null;
  useTls: boolean;
};

export type SubscribeRequest = { topicFilter: string; qos: number };

export type PublishRequest = { topic: string; payload: string; qos: number; retain: boolean };

export type MqttMessage = {
  topic: string;
  payload: string;
  qos: number;
  retain: boolean;
  receivedAt: string;
};
