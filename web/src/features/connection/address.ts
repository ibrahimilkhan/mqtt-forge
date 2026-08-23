import type { Scheme } from './scheme';

/**
 * A broker address as it is written down, taken apart into the fields the panel holds.
 *
 * Every broker's own documentation gives you one string — `mqtts://broker.hivemq.com:8883`,
 * `wss://host:8084/mqtt` — and the panel asks for it in three or four separate controls. Taking
 * it apart by hand is the first thing anyone does here and the easiest thing to get wrong: the
 * port and the scheme have to agree, and the path only exists on two of the four schemes. So the
 * Host box accepts the whole thing and splits it itself.
 *
 * Fields that were not in the address are absent rather than defaulted. What a missing port or a
 * missing path should become depends on what the form already holds, which is the panel's
 * question, not this one's.
 */
export type BrokerAddress = {
  scheme?: Scheme;
  host: string;
  port?: number;
  webSocketPath?: string;
};

/**
 * The names a scheme goes by, as against the four this console offers.
 *
 * `tcp://` and `ssl://` are what the Paho and Eclipse documentation writes, `mqtt+ssl://` is
 * HiveMQ's, and `http(s)://` is what you get when you copy a WebSocket endpoint out of a browser
 * address bar. They all name a way in that this panel already has, and refusing them would mean
 * refusing a paste for spelling.
 */
const ALIASES: Readonly<Record<string, Scheme>> = {
  mqtt: 'mqtt',
  tcp: 'mqtt',
  mqtts: 'mqtts',
  ssl: 'mqtts',
  tls: 'mqtts',
  'mqtt+ssl': 'mqtts',
  'mqtts+ssl': 'mqtts',
  ws: 'ws',
  http: 'ws',
  wss: 'wss',
  https: 'wss',
};

/** Ports are 16-bit and 0 is not one a broker listens on. */
const isPort = (value: number) => Number.isInteger(value) && value > 0 && value < 65536;

/**
 * Splits an address, or says it is not one.
 *
 * Null means "there is nothing here to take apart" — a bare hostname, or something this cannot
 * make sense of — and the caller should leave what was typed exactly where it was typed. A
 * scheme it does not recognise counts as not making sense: guessing at `foo://` would put a
 * connection on a transport nobody chose.
 */
export function parseBrokerAddress(text: string): BrokerAddress | null {
  let rest = text.trim();
  if (rest === '') return null;

  let scheme: Scheme | undefined;
  const schemed = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.*)$/s.exec(rest);
  if (schemed) {
    scheme = ALIASES[schemed[1].toLowerCase()];
    if (!scheme) return null;
    rest = schemed[2];
  }

  // Whatever a browser or a copied connection string hung on the end. Neither is part of an
  // address a broker is dialled at, and a path carrying one is a path that will not match.
  rest = rest.split(/[?#]/, 1)[0];

  // A path may only follow the authority, so the first slash ends it. Anything the credentials
  // half of a URL carries is dropped rather than filled in: a password does not belong in a
  // text box that is not a password box, and half a credential is worse than none.
  const slash = rest.indexOf('/');
  const authority = (slash === -1 ? rest : rest.slice(0, slash)).replace(/^[^@]*@/, '');
  const path = slash === -1 ? '' : rest.slice(slash);

  const { host, port } = splitPort(authority);
  if (host === '') return null;

  // A lone slash is not a path anyone means; `/mqtt` is.
  const webSocketPath = path === '' || path === '/' ? undefined : path;

  // Nothing was taken apart, so there is nothing to hand back: the text is a hostname and
  // belongs in the box it was typed into, untouched.
  if (!scheme && port === undefined && webSocketPath === undefined) return null;

  return { scheme, host, port, webSocketPath };
}

/**
 * `host`, `host:port`, or `[::1]:port`.
 *
 * The brackets are the whole reason this is not a split on the last colon: an IPv6 literal is
 * nothing but colons, and `::1` would otherwise come apart into a host of `:` and a port of 1.
 */
function splitPort(authority: string): { host: string; port?: number } {
  const bracketed = /^\[([^\]]*)\](?::(\d+))?$/.exec(authority);
  if (bracketed) {
    const port = bracketed[2] === undefined ? undefined : Number(bracketed[2]);
    return { host: bracketed[1], port: port !== undefined && isPort(port) ? port : undefined };
  }

  const split = /^([^:]*):(\d+)$/.exec(authority);
  if (!split) return { host: authority };

  const port = Number(split[2]);
  return isPort(port) ? { host: split[1], port } : { host: split[1] };
}
