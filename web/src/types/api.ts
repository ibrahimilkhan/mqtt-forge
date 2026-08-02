// Mirrors MQFaker.Api.Contracts; ASP.NET serialises camelCase.
export type ConnectionState = 'Disconnected' | 'Connecting' | 'Connected' | 'Faulted';

export type ConnectionStateResponse = { state: ConnectionState; alreadyConnected?: boolean };

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
