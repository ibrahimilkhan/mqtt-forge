import type { MqttProtocolLevel, MqttTransport } from '../../types/api';

/**
 * The four ways in, named the way people write them down.
 *
 * The API keeps these as two fields — a transport and a TLS flag — because that is what every
 * other part of it already asks about: a failure, a live link and the saved settings all carry
 * "was this encrypted" on its own. But nobody picks a transport and a boolean. They pick
 * `mqtts://`, which is what is on the broker's own documentation page, so that is what the panel
 * offers and this is where the two shapes meet.
 */
export type Scheme = 'mqtt' | 'mqtts' | 'ws' | 'wss';

export type SchemeChoice = {
  scheme: Scheme;
  transport: MqttTransport;
  useTls: boolean;
  /** What the broker almost certainly listens on, when nobody has said otherwise. */
  defaultPort: number;
};

export const SCHEMES: readonly SchemeChoice[] = [
  {
    scheme: 'mqtt',
    transport: 'tcp',
    useTls: false,
    defaultPort: 1883,
  },
  {
    scheme: 'mqtts',
    transport: 'tcp',
    useTls: true,
    defaultPort: 8883,
  },
  {
    scheme: 'ws',
    transport: 'webSocket',
    useTls: false,
    defaultPort: 8083,
  },
  {
    scheme: 'wss',
    transport: 'webSocket',
    useTls: true,
    defaultPort: 8084,
  },
];

// Both of these fall back rather than throw. A transport or a scheme this console has not heard
// of can only come from a backend newer than it, and a panel that will not render is a worse
// answer to that than one drawing the plain case: the encryption half is preserved either way,
// which is the half that would matter if it were wrong.
export const schemeOf = (transport: MqttTransport, useTls: boolean): Scheme =>
  SCHEMES.find((s) => s.transport === transport && s.useTls === useTls)?.scheme ??
  (useTls ? 'mqtts' : 'mqtt');

export const choiceOf = (scheme: Scheme): SchemeChoice =>
  SCHEMES.find((s) => s.scheme === scheme) ?? SCHEMES[0];

export const isWebSocket = (scheme: Scheme) => choiceOf(scheme).transport === 'webSocket';

export const isEncrypted = (scheme: Scheme) => choiceOf(scheme).useTls;

/**
 * The port to show after a scheme change.
 *
 * Only when the port on screen is the one the OLD scheme filled in by itself. A number somebody
 * typed is theirs — a broker on 21883 stays on 21883 when they switch to TLS to find out what
 * happens — and a scheme picker that quietly rewrote it would be the kind of help you have to
 * undo. Everything else moves, because 1883 under `wss://` is a port nothing listens on.
 */
export function portFor(from: Scheme, to: Scheme, port: number): number {
  return port === choiceOf(from).defaultPort ? choiceOf(to).defaultPort : port;
}

/**
 * The scheme a port implies, when it implies one.
 *
 * The mirror of `portFor`, and deliberately the smaller half of it: this moves along the
 * encryption axis only and never crosses the transport. Somebody on `wss` who types 8883 chose
 * the WebSocket on purpose, and 8883 over `wss` is a configuration brokers really run — guessing
 * across the transport would undo a choice, where guessing along encryption only ever corrects
 * the mistake that actually happens, which is plain MQTT aimed at the encrypted port.
 *
 * There is no "was this port typed" guard, the way `portFor` has one, because here the port IS
 * what was typed. The panel calls this when the box is left rather than on the keystroke, for
 * the same reason the address box splits on the way out: 8883 typed a digit at a time passes
 * through 8, 88 and 888, and a scheme that moved on each of them would land wherever the last
 * keystroke happened to leave it.
 */
export function schemeForPort(from: Scheme, port: number): Scheme {
  const { transport } = choiceOf(from);

  return SCHEMES.find((s) => s.transport === transport && s.defaultPort === port)?.scheme ?? from;
}

/**
 * The numbers, for reading back rather than for choosing between.
 *
 * The console does not ask which MQTT to speak — it offers 5.0, then 3.1.1, then 3.1, and keeps
 * the first one the broker takes, the reader being the wrong person to ask what their broker
 * speaks. So this is only ever consulted about a version that has already happened: the one a
 * link reports, or the one a failure was about.
 */
const VERSIONS: ReadonlyArray<{ value: MqttProtocolLevel; label: string }> = [
  { value: 'v500', label: '5.0' },
  { value: 'v311', label: '3.1.1' },
  { value: 'v310', label: '3.1' },
];

/** How a version reads in a sentence. */
// A version with no entry here is one a newer backend named; printing it as it came is more use
// than printing nothing, and it is the only place in the panel that would have said so at all.
export const versionName = (value: MqttProtocolLevel): string => {
  if (value === 'auto') return 'whichever version fits';

  const known = VERSIONS.find((v) => v.value === value);

  return known ? `MQTT ${known.label}` : String(value);
};
