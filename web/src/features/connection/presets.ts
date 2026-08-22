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
  /** One line under the form: what the broker is, and what to expect from it. */
  note: string;
};

export const BROKER_PRESETS: readonly BrokerPreset[] = [
  {
    name: 'Local Mosquitto',
    host: 'localhost',
    port: 1883,
    useTls: false,
    username: '',
    onConnectFilter: '#',
    note: 'A broker on this machine — the only one here that will answer a bare #, because the only traffic on it is yours.',
  },
  {
    name: 'Helsinki transit',
    host: 'mqtt.hsl.fi',
    port: 8883,
    useTls: true,
    username: '',
    onConnectFilter: '/hfp/v2/journey/ongoing/vp/tram/#',
    note: 'Every tram in Helsinki, reporting position and speed: about 130 messages a second. Swap tram for bus, train or metro.',
  },
  {
    name: 'HiveMQ',
    host: 'broker.hivemq.com',
    port: 8883,
    useTls: true,
    username: '',
    onConnectFilter: 'testtopic/#',
    note: "Public test broker, open to anyone. Around 10 messages a second of other people's testing. Refuses a bare #.",
  },
  {
    name: 'EMQX',
    host: 'broker.emqx.io',
    port: 8883,
    useTls: true,
    username: '',
    onConnectFilter: 'testtopic/#',
    note: 'Public test broker, all but silent. Bring your own traffic from the Publish panel. Refuses a bare #.',
  },
  {
    name: 'Mosquitto test',
    host: 'test.mosquitto.org',
    port: 8886,
    useTls: true,
    username: 'wildcard',
    onConnectFilter: '#',
    note: 'The original public test broker. The wildcard username is what buys a # subscription here, and it lasts 20 seconds — long enough to see what topics exist.',
  },
];

/** What the form holds before any preset is picked, and what Local Mosquitto restates. */
export const NO_PRESET_FILTER = '#';
