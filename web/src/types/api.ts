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

/**
 * What the supervisor is doing about the link, which is not what the link is doing.
 *
 * `state` answers "is there a link"; this answers "is anyone working on getting one back". They
 * have to be two things: through a reconnect the link's own state flickers Faulted → Connecting →
 * Faulted once a rung, which is the truth about the socket and useless as something to show
 * somebody — it says nothing about how many rungs have gone or when the next one is.
 */
export type ReconnectStatus = {
  /** The option. Off means the supervisor does nothing at all, whatever the link does. */
  enabled: boolean;
  /** Whether an outage is being worked on right now. Distinct from `enabled`, and both matter. */
  active: boolean;
  /** Attempts spent on this outage. Zero while the first wait is still running. */
  attempt: number;
  /**
   * When the next attempt is due, as an absolute instant.
   *
   * Not a number of seconds: a count is stale the moment it is serialised, and the console runs
   * its own countdown anyway — which it can only do against a fixed point.
   */
  nextAttemptAt: string | null;
  /** This outage was called off by hand. The option is still on. */
  gaveUp: boolean;
  /**
   * The instant on the server's clock that this status was true at.
   *
   * `nextAttemptAt` is on that same clock, so their difference is a duration — which is a thing
   * the browser can add to its own clock. Without it, a console on a machine two minutes fast
   * would draw the skew between the two as time remaining.
   */
  now: string;
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

// ---- alerting ----
//
// These carry the Dto suffix where nothing else in this file does, and it is deliberate: they are
// the names of the C# records in MqttForge.Api.Contracts, and the shape below is a contract shared
// by three readers at once — alert-rules.json on disk, the wire, and this file. Renaming it on the
// way in would make the browser the one place the shape is called something else, and a reader
// comparing AlertJsonShapeTests with this file would have to translate before they could compare.

/**
 * How loud an alarm is.
 *
 * Three levels rather than five, because the console picks a tone and a place on the alarm wall
 * from this, and a level nobody can tell from its neighbour by ear or by eye only makes the
 * editor longer. Ordered: the panel sorts active alarms by it, critical last.
 *
 * Exported as a name of its own rather than left inline on the two records that hold it, because
 * the wall, the rail badge and the sound all switch on it and a union spelled out in four
 * places is a union that grows a fourth level in three of them.
 */
export type AlertSeverity = 'info' | 'warn' | 'critical';

export type ThresholdOp = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq';

/** Which fence an outlier is judged against — a Tukey box, or deviations from the mean. */
export type OutlierMethod = 'tukey' | 'sigma';

/** One number about the rhythm of a signal. `duty` is a share of the readings, never of time. */
export type PulseMetric = 'count' | 'duty' | 'period' | 'width';

/**
 * What a rule asks of a topic: a closed, recursive union discriminated on `type`.
 *
 * Written as a discriminated union rather than one wide optional-everything record so that a
 * switch over `condition.type` is exhaustive — the editor draws a different form per case, and
 * the day a twelfth condition is added to the engine the compiler is what says which forms are
 * missing. `all` and `any` hold other conditions, so a rule is a tree and not a list of clauses
 * joined by a hidden AND.
 *
 * `window` and `k` are optional here and are always present on the wire coming back, because the
 * server's records hold plain ints: an absent member is written as 0, and 0 is how 'not given' is
 * said. The editor omits them rather than sending 0, which is the same request.
 */
export type AlertCondition =
  | { type: 'threshold'; op: ThresholdOp; value: number }
  | { type: 'band'; low: number; high: number; inside: boolean }
  | { type: 'pattern'; regex: string; negate: boolean }
  | { type: 'oneOf'; values: string[]; negate: boolean }
  | { type: 'all'; of: AlertCondition[] }
  | { type: 'any'; of: AlertCondition[] }
  | { type: 'silence'; after: number }
  | { type: 'outlier'; method: OutlierMethod; k?: number; window?: number }
  | { type: 'distributionShift'; window?: number }
  | { type: 'shapeChange'; window?: number }
  | { type: 'pulse'; metric: PulseMetric; op: ThresholdOp; value: number; window?: number };

/** The eleven words, for the editor's own list of what it can offer. */
export type ConditionType = AlertCondition['type'];

export type AlertActionType = 'screen' | 'sound' | 'webhook' | 'publish';

/**
 * One channel, flattened — the same shape whichever of the four it is.
 *
 * Flat rather than a union like the condition above, and the reason is which side does the
 * refusing: an unknown condition is refused by the serialiser, while an unknown action reaches a
 * validator that can name it in a sentence.
 *
 * `headers` and `headerNames` are the two halves of one rule: a GET carries the NAMES of a
 * webhook's headers and never their values, and a PUT carries `headers` where a name given with
 * an empty value means keep the value already on disk. `headers` absent is not `headers` empty —
 * absent is 'I am not editing them', empty is 'there are none'.
 */
export type AlertActionDto = {
  type: AlertActionType;
  url?: string;
  headers?: Record<string, string>;
  headerNames?: string[];
  /** A publish action's topic. Null is the server's own default, "{prefix}{ruleId}/{topic}". */
  topic?: string | null;
  qos?: number;
  retain?: boolean;
};

/**
 * A rule on the wire.
 *
 * `id` is null on a rule being written for the first time: the server hands one out and sends it
 * back, which is why a save answers with the rules rather than with 204. Null and not absent,
 * because the editor's draft has to hold the field either way and a member that comes and goes is
 * one the compiler stops being able to help with.
 */
export type AlertRuleDto = {
  id: string | null;
  name: string;
  enabled: boolean;
  filter: string;
  field: string | null;
  condition: AlertCondition;
  /** The way out. Absent means the condition going false is the way out. */
  clear: AlertCondition | null;
  /** Seconds the condition must hold before it rings. */
  for: number | null;
  /** Seconds of quiet after it stops, before the same pair may ring again. */
  cooldown: number | null;
  severity: AlertSeverity;
  actions: AlertActionDto[];
};

/**
 * One alarm.
 *
 * `sample` is 256 bytes of the body that fired it, cut on a character rather than on a byte, so a
 * payload of Turkish text is never handed over ending in half a letter.
 */
export type AlertDto = {
  id: string;
  ruleId: string;
  ruleName: string;
  topic: string;
  severity: AlertSeverity;
  firedAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  mutedUntil: string | null;
  /** How many messages stayed on the wrong side while this alarm stood. Starts at one. */
  count: number;
  reason: string;
  value: number | null;
  sample: string | null;
  /**
   * What each channel did with this alarm. The words and not the actions: a delivery that failed
   * is written 'webhook: 404', so this is free text and not the action union — the colon is what
   * tells a failure from a plain channel name.
   *
   * The console only ever acts on the channel name — draw a notice, make a noise — and a webhook's
   * URL is server business that an alarm list has no reason to broadcast to every connected tab.
   */
  actions: string[];
};

/** A silenced pair, and the moment it starts speaking again. */
export type MutedPairDto = { ruleId: string; topic: string; until: string };

/** What one rule has actually seen. A quiet alert rule is not good news. */
export type RuleDiagnosticDto = {
  ruleId: string;
  topics: number;
  evaluated: number;
  skipped: number;
  lastFiredAt: string | null;
  faulted: boolean;
  faultReason: string | null;
};

/**
 * A rule at a ceiling, and how many topics it has had to stop watching.
 *
 * A row rather than a count on the parent, because `untracked` has no other source: the sentence
 * the panel writes is 'n rules reached a ceiling — m topics untracked', and m is the half of it
 * anybody can act on.
 */
export type CappedRuleDto = { ruleId: string; untracked: number };

/**
 * A pair still filling the shortest run the engine will judge anything on.
 *
 * `note` is the server's own sentence. It is sent rather than built here because this endpoint has
 * three readers — the panel, whoever curls it, and whatever a person wires it into — and a number
 * pair each of them phrases for itself is three different sentences about one fact.
 */
export type WarmingPairDto = {
  ruleId: string;
  topic: string;
  have: number;
  need: number;
  note: string;
};

/** Everything GET /api/alerts answers, and everything the alerts panel draws. */
export type AlertsDto = {
  active: AlertDto[];
  history: AlertDto[];
  muted: MutedPairDto[];
  rules: RuleDiagnosticDto[];
  /** What the engine never judged, because its own queue was full. */
  dropped: number;
  /** Webhook calls dropped by the dispatcher's queue. */
  webhooksDropped: number;
  /** Alarms that were judged and not told, because their pair was muted or cooling. */
  suppressed: number;
  capped: CappedRuleDto[];
  /**
   * How long this engine has been unable to see anything, in seconds.
   *
   * The one number that explains a silent alerting system, and so the one that must never be
   * missing: a broker that has been down for an hour and a plant with nothing wrong with it look
   * exactly alike from a panel with no alarms on it.
   */
  blindSeconds: number;
  warming: WarmingPairDto[];
};

/** What GET /api/alert-rules answers: the rules, and the two facts about this host. */
export type AlertRulesResponseDto = {
  rules: AlertRuleDto[];
  /** False where the operator has turned webhooks off. A rule may still carry one. */
  allowWebhooks: boolean;
  /** What alert publishes are published under. */
  topicPrefix: string;
  /** Some of the file could not be read. `skippedIds` names what was lost. */
  unreadable: boolean;
  skippedIds: string[];
};

/** One rule that saved, and one sentence about why it will not do what it says. */
export type SaveWarningDto = { ruleId: string; reason: string };

/** What a PUT answers: what was written, and what was allowed but is not going to happen. */
export type AlertRulesSavedDto = { rules: AlertRuleDto[]; warnings: SaveWarningDto[] };
