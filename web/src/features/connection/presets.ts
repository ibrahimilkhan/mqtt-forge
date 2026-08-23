import type { MqttProtocolLevel, TlsOptions } from '../../types/api';
import type { Scheme } from './scheme';

/**
 * Brokers worth pointing this console at, and what to listen to once each one is up.
 *
 * A preset carries a topic filter, not just an address, because an address alone does not get
 * you a working console. A bare '#' is refused by nearly every public broker — some answer with
 * a failing SUBACK, some close the session outright — so a preset that filled in the host and
 * left the filter at '#' would connect and then immediately fall over. The filter is the half
 * that makes the address useful.
 *
 * Rates below were measured against each broker, and are what one subtree gives at a quiet
 * hour rather than a promise. They are here so the notes can say whether a preset is worth
 * opening for something to watch, or is just somewhere to publish your own traffic.
 */
export type BrokerPreset = {
  /** Shown on the chip, and the identity the panel tracks the choice by. */
  name: string;
  /**
   * Empty for a cloud service, where the address belongs to the account rather than to the
   * service. Those presets fill in everything else — the scheme, the port, the path — which is
   * the part people get wrong, and clear the host so it is obvious what is still needed.
   */
  host: string;
  port: number;
  scheme: Scheme;
  /** Brokers wanting none get ''. Never a password: presets are public knowledge by definition. */
  username: string;
  /** Subscribed to on connect, when the box beside it is ticked. */
  onConnectFilter: string;
  /** One short line under the chips: what the broker is. */
  note: string;
  /** Only where the broker publishes one. Everything else takes the default. */
  webSocketPath?: string;
  /** Only where the broker needs one named. Auto is right for everything in service today. */
  protocolVersion?: MqttProtocolLevel;
  /** Only what the service requires and a reader could not guess. */
  tls?: TlsOptions;
  /**
   * Someone else's broker, out on the internet.
   *
   * Worth offering — they are the fastest way to see the console work without standing a broker
   * up first — but none of them is the answer to 'which broker am I connecting to', and four of
   * them above the form made picking the real one a reading exercise. They sit in their own
   * section at the foot of the panel instead, out of the way of the fields.
   */
  public?: true;
  /**
   * A managed service you have an account with. Kept apart from the public brokers because
   * picking one is not a way to see something happen — it is the shape of a connection you are
   * about to finish filling in yourself.
   */
  cloud?: true;
};

export const BROKER_PRESETS: readonly BrokerPreset[] = [
  {
    name: 'Local Mosquitto',
    host: 'localhost',
    port: 1883,
    scheme: 'mqtt',
    username: '',
    onConnectFilter: '#',
    note: 'On this machine. The only one here that answers a bare #.',
  },

  // ---- someone else's, open to anyone ----
  {
    name: 'Helsinki transit',
    public: true,
    host: 'mqtt.hsl.fi',
    port: 8883,
    scheme: 'mqtts',
    username: '',
    onConnectFilter: '/hfp/v2/journey/ongoing/vp/tram/#',
    note: 'Every tram in Helsinki. About 130 messages a second. Swap tram for bus, train or metro.',
  },
  {
    name: 'HiveMQ',
    public: true,
    host: 'broker.hivemq.com',
    port: 8883,
    scheme: 'mqtts',
    username: '',
    onConnectFilter: 'testtopic/#',
    note: "Around 10 messages a second of other people's testing. Refuses a bare #.",
  },
  {
    name: 'HiveMQ over WSS',
    public: true,
    host: 'broker.hivemq.com',
    port: 8884,
    scheme: 'wss',
    webSocketPath: '/mqtt',
    username: '',
    onConnectFilter: 'testtopic/#',
    note: 'The same broker through an encrypted WebSocket — the way in when only 443 is open.',
  },
  {
    name: 'EMQX',
    public: true,
    host: 'broker.emqx.io',
    port: 8883,
    scheme: 'mqtts',
    username: '',
    onConnectFilter: 'testtopic/#',
    note: 'All but silent. Bring your own traffic from Publish. Refuses a bare #.',
  },
  {
    name: 'EMQX over WSS',
    public: true,
    host: 'broker.emqx.io',
    port: 8084,
    scheme: 'wss',
    webSocketPath: '/mqtt',
    username: '',
    onConnectFilter: 'testtopic/#',
    note: 'The same broker over an encrypted WebSocket, on the path /mqtt.',
  },
  {
    name: 'Mosquitto test',
    public: true,
    host: 'test.mosquitto.org',
    port: 8886,
    scheme: 'mqtts',
    username: 'wildcard',
    onConnectFilter: '#',
    note: 'The wildcard username buys a # subscription here, for 20 seconds.',
  },

  // ---- managed services, where the address is yours ----
  //
  // Ports, paths and the shape of the username are what people get wrong about these, and every
  // one of them is written down somewhere different. That is what these presets carry; the host
  // is cleared because it belongs to your account and nothing here could guess it.
  {
    name: 'HiveMQ Cloud',
    cloud: true,
    host: '',
    port: 8883,
    scheme: 'mqtts',
    username: '',
    onConnectFilter: '#',
    note: 'Paste the cluster URL from the HiveMQ console — it ends .hivemq.cloud — and use the '
      + 'access credentials you made there. Its certificate is publicly trusted, so nothing '
      + 'under Encryption needs filling in. Port 8884 with wss:// works too.',
  },
  {
    name: 'EMQX Cloud',
    cloud: true,
    host: '',
    port: 8883,
    scheme: 'mqtts',
    username: '',
    onConnectFilter: '#',
    note: 'The deployment address from the EMQX console, ending .emqxsl.com for Serverless, with '
      + 'a username you added under Authentication. Serverless refuses plain MQTT — it is TLS or '
      + 'nothing. Port 8084 with wss:// and the path /mqtt is the WebSocket way in.',
  },
  {
    name: 'AWS IoT Core',
    cloud: true,
    host: '',
    port: 8883,
    scheme: 'mqtts',
    username: '',
    onConnectFilter: '#',
    note: 'The ATS endpoint from `aws iot describe-endpoint`, and no password: AWS knows you by '
      + 'your certificate. Point Client certificate at the .pem.crt it gave you, Private key at '
      + 'the .pem.key, and Extra CA certificate at AmazonRootCA1.pem. On port 443 instead, set '
      + 'ALPN protocol to x-amzn-mqtt-ca. What a subscription may reach is your IoT policy, so '
      + 'narrow the filter if a bare # is refused.',
  },
  {
    name: 'Azure IoT Hub',
    cloud: true,
    host: '',
    port: 8883,
    scheme: 'mqtts',
    username: '',
    onConnectFilter: 'devices/+/messages/devicebound/#',
    note: 'Host is <hub>.azure-devices.net, and the client ID is the device ID exactly. The '
      + 'username is <hub>.azure-devices.net/<deviceId>/?api-version=2021-04-12 and the password '
      + 'is a SAS token. Azure allows only the topics it defines, so a bare # is refused.',
  },
];

/** A broker of your own, which is what this panel is for. */
export const LOCAL_PRESETS = BROKER_PRESETS.filter((preset) => !preset.public && !preset.cloud);

/** Everyone else's, kept together at the foot of the panel. */
export const PUBLIC_PRESETS = BROKER_PRESETS.filter((preset) => preset.public);

/** Managed services: the shape of the connection, with the address left to you. */
export const CLOUD_PRESETS = BROKER_PRESETS.filter((preset) => preset.cloud);

/** What the form holds before any preset is picked, and what Local Mosquitto restates. */
export const NO_PRESET_FILTER = '#';
