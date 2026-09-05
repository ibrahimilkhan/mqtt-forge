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
  /** The user half of `user:pass@host`, when the address carried one. */
  username?: string;
  /** The password half. Goes to the password box, never to the address box. */
  password?: string;
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

  // A path may only follow the authority, so the first slash ends it.
  const slash = rest.indexOf('/');
  const beforePath = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? '' : rest.slice(slash);

  // The credentials half, handed to the boxes that are for it. It used to be dropped on the
  // floor — the objection being that a password does not belong in a text box that is not a
  // password box, which is right about the Address box and wrong about the Password box a few
  // lines below it. Dropping it silently meant a reader who pasted the connection string their
  // broker's dashboard gave them was dialled anonymously and told their credentials were
  // refused. Percent-encoding is undone the way a URL's userinfo is written.
  const at = beforePath.lastIndexOf('@');
  const userinfo = at === -1 ? '' : beforePath.slice(0, at);
  const authority = at === -1 ? beforePath : beforePath.slice(at + 1);
  const colon = userinfo.indexOf(':');
  const username = decode(colon === -1 ? userinfo : userinfo.slice(0, colon));
  const password = colon === -1 ? '' : decode(userinfo.slice(colon + 1));

  const { host, port } = splitPort(authority);
  if (host === '') return null;

  // A lone slash is not a path anyone means; `/mqtt` is.
  const webSocketPath = path === '' || path === '/' ? undefined : path;

  // Nothing was taken apart, so there is nothing to hand back: the text is a hostname and
  // belongs in the box it was typed into, untouched. Credentials count as taking it apart —
  // `forge:secret@host` is not a hostname anybody typed.
  if (!scheme && port === undefined && webSocketPath === undefined && username === '') return null;

  return {
    scheme,
    host,
    port,
    webSocketPath,
    username: username === '' ? undefined : username,
    password: password === '' ? undefined : password,
  };
}

/** Percent-decoding that gives the text back rather than throwing on a stray '%'. */
const decode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

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

/**
 * A scheme and a host, written back out as the address they came from.
 *
 * The inverse of `parseBrokerAddress` for the half the Address box shows. The port is
 * deliberately not in it: the panel keeps the port in a control of its own, where it can be
 * stepped rather than edited in the middle of a string, and it is the part of an address people
 * change on its own most often.
 *
 * An empty host leaves the scheme standing alone — `mqtts://` — which is what a cloud preset
 * puts in the box, the port and the path being filled in and the address being yours.
 */
export function formatBrokerAddress(scheme: Scheme, host: string): string {
  const trimmed = host.trim();
  if (trimmed === '') return `${scheme}://`;

  // An IPv6 literal goes back inside its brackets. `parseBrokerAddress` takes them off —
  // `[::1]` comes out as a host of `::1` — and writing that back bare would produce an address
  // that cannot be read again, since it is nothing but colons and `splitPort` would take the
  // last one for a port. A host that still has its brackets keeps them rather than gaining a
  // second pair.
  const bracketed = trimmed.includes(':') && !trimmed.startsWith('[');

  return `${scheme}://${bracketed ? `[${trimmed}]` : trimmed}`;
}
