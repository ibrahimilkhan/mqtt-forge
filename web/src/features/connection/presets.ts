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
  host: string;
  port: number;
  useTls: boolean;
  /** Brokers wanting none get ''. Never a password: presets are public knowledge by definition. */
  username: string;
  /** Subscribed to on connect, when the box beside it is ticked. */
  onConnectFilter: string;
  /** One short line under the chips: what the broker is. */
  note: string;
  /**
   * Someone else's broker, out on the internet.
   *
   * Worth offering — they are the fastest way to see the console work without standing a broker
   * up first — but none of them is the answer to 'which broker am I connecting to', and four of
   * them above the form made picking the real one a reading exercise. They sit in their own
   * section at the foot of the panel instead, out of the way of the fields.
   */
  public?: true;
};

export const BROKER_PRESETS: readonly BrokerPreset[] = [
  {
    name: 'Local Mosquitto',
    host: 'localhost',
    port: 1883,
    useTls: false,
    username: '',
    onConnectFilter: '#',
    note: 'On this machine. The only one here that answers a bare #.',
  },
  {
    name: 'Helsinki transit',
    public: true,
    host: 'mqtt.hsl.fi',
    port: 8883,
    useTls: true,
    username: '',
    onConnectFilter: '/hfp/v2/journey/ongoing/vp/tram/#',
    note: 'Every tram in Helsinki. About 130 messages a second. Swap tram for bus, train or metro.',
  },
  {
    name: 'HiveMQ',
    public: true,
    host: 'broker.hivemq.com',
    port: 8883,
    useTls: true,
    username: '',
    onConnectFilter: 'testtopic/#',
    note: "Around 10 messages a second of other people's testing. Refuses a bare #.",
  },
  {
    name: 'EMQX',
    public: true,
    host: 'broker.emqx.io',
    port: 8883,
    useTls: true,
    username: '',
    onConnectFilter: 'testtopic/#',
    note: 'All but silent. Bring your own traffic from Publish. Refuses a bare #.',
  },
  {
    name: 'Mosquitto test',
    public: true,
    host: 'test.mosquitto.org',
    port: 8886,
    useTls: true,
    username: 'wildcard',
    onConnectFilter: '#',
    note: 'The wildcard username buys a # subscription here, for 20 seconds.',
  },
];

/** A broker of your own, which is what this panel is for. */
export const LOCAL_PRESETS = BROKER_PRESETS.filter((preset) => !preset.public);

/** Everyone else's, kept together at the foot of the panel. */
export const PUBLIC_PRESETS = BROKER_PRESETS.filter((preset) => preset.public);

/** What the form holds before any preset is picked, and what Local Mosquitto restates. */
export const NO_PRESET_FILTER = '#';
