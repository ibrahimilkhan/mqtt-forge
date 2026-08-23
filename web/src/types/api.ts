// Mirrors MqttForge.Api.Contracts; ASP.NET serialises camelCase, enums included.
export type ConnectionState = 'Disconnected' | 'Connecting' | 'Connected' | 'Faulted';

/** What carries the packets. Encryption is the separate useTls flag beside it. */
export type MqttTransport = 'tcp' | 'webSocket';

/**
 * Which MQTT to speak. 'auto' is not a version — it is the instruction to try 5.0, then 3.1.1,
 * then 3.1, and keep the first one the broker accepts. A link reports the one it got.
 */
export type MqttProtocolLevel = 'auto' | 'v500' | 'v311' | 'v310';

// Set only alongside Faulted, and only when the API could work out a cause. It names the
// broker too: the saved settings record the last SUCCESSFUL connect, so a failed attempt to
// somewhere else leaves nothing on this side to match it against.
export type BrokerFailure = {
  reason: string;
  host: string;
  port: number;
  clientId: string;
  useTls: boolean;
  transport: MqttTransport;
  /** What was asked for. 'auto' means every version was offered and none taken. */
  protocolVersion: MqttProtocolLevel;
};

// Set only alongside Connected: which broker is up, and what it said when it accepted. The
// mirror of BrokerFailure — the API sends whichever of the two applies, never both.
export type BrokerLink = {
  host: string;
  port: number;
  clientId: string;
  username: string | null;
  useTls: boolean;
  connectedAt: string;
  sessionPresent: boolean;
  assignedClientId: string | null;
  serverKeepAlive: number | null;
  transport: MqttTransport;
  /** The version the broker agreed to — never 'auto', which is a request and not an answer. */
  protocolVersion: Exclude<MqttProtocolLevel, 'auto'>;
};

export type ConnectionStateResponse = {
  state: ConnectionState;
  failure?: BrokerFailure | null;
  connection?: BrokerLink | null;
  alreadyConnected?: boolean;
};

/** A connection somebody kept, under the name they kept it under. */
export type SavedProfile = { name: string; connection: SavedConnection };

export type SavedConnection = {
  host: string;
  port: number;
  clientId: string;
  username: string | null;
  hasPassword: boolean;
  useTls: boolean;
  transport: MqttTransport;
  protocolVersion: MqttProtocolLevel;
  webSocketPath: string | null;
  cleanSession: boolean;
  sessionExpiryInterval: number | null;
  /** Null when the connection never touched the encryption fields at all. */
  tls: SavedTlsOptions | null;
};

export type SavedTlsOptions = {
  allowUntrustedCertificates: boolean;
  certificateAuthorityPath: string | null;
  clientCertificatePath: string | null;
  clientCertificateKeyPath: string | null;
  hasClientCertificatePassword: boolean;
  sniHost: string | null;
  alpnProtocol: string | null;
};

/**
 * Everything past useTls is optional on the wire — the API defaults each one to what a
 * connection made before any of this existed would have got.
 */
export type ConnectRequest = {
  host: string;
  port: number;
  clientId: string;
  username: string | null;
  password: string | null;
  useTls: boolean;
  transport?: MqttTransport;
  protocolVersion?: MqttProtocolLevel;
  webSocketPath?: string | null;
  cleanSession?: boolean;
  sessionExpiryInterval?: number | null;
  tls?: TlsOptions | null;
};

/** The parts of TLS that need a field. Sent whole or not at all. */
export type TlsOptions = {
  allowUntrustedCertificates?: boolean;
  certificateAuthorityPath?: string | null;
  clientCertificatePath?: string | null;
  clientCertificateKeyPath?: string | null;
  clientCertificatePassword?: string | null;
  sniHost?: string | null;
  alpnProtocol?: string | null;
};

export type SubscribeRequest = { topicFilter: string; qos: number };

export type PublishRequest = {
  topic: string;
  payload: string;
  payloadEncoding: 'text' | 'base64';
  qos: number;
  retain: boolean;
};

export type MqttMessage = {
  topic: string;
  payload: string;
  /** Absent means text: the server only sends 'base64' when the bytes are not valid UTF-8. */
  payloadEncoding?: 'text' | 'base64';
  qos: number;
  retain: boolean;
  receivedAt: string;
};
