import type { ConnectRequest, SavedConnection, TlsOptions } from '../../types/api';
import { parseBrokerAddress } from './address';
import {
  choiceOf,
  isEncrypted,
  isWebSocket,
  portFor,
  schemeForPort,
  schemeOf,
  type Scheme,
} from './scheme';

/**
 * What the panel holds while it is being filled in.
 *
 * Flat, and all strings where the field is a text box — including the two numbers. An empty box
 * is a real state a reader gets to ("say nothing about session expiry"), and `number | ''` in
 * the state is how that survives being typed into and cleared again. The port is the exception,
 * since it always has a value.
 */
export type BrokerForm = {
  scheme: Scheme;
  host: string;
  port: number;
  clientId: string;
  username: string;
  password: string;
  webSocketPath: string;
  cleanSession: boolean;
  sessionExpiry: string;
  allowUntrusted: boolean;
  caPath: string;
  clientCertPath: string;
  clientKeyPath: string;
  clientCertPassword: string;
  sniHost: string;
  alpnProtocol: string;
};

/**
 * The form as the API wants it.
 *
 * Fields that belong to a scheme the reader has moved away from are dropped rather than sent:
 * a path left over from a WebSocket, or a CA typed before switching back to plain MQTT, would
 * otherwise be saved as part of a connection that never used it and reappear the next time the
 * panel opens — looking, on a connection that then failed, exactly like the reason.
 */
export function buildConnectRequest(form: BrokerForm): ConnectRequest {
  const choice = choiceOf(form.scheme);

  return {
    host: form.host.trim(),
    port: Number(form.port),
    clientId: form.clientId,
    username: form.username || null,
    password: form.password || null,
    useTls: choice.useTls,
    transport: choice.transport,
    // Always. Auto offers 5.0, then 3.1.1, then 3.1, and keeps the first one the broker takes —
    // and the reader is the wrong person to ask which their broker speaks. A fixed version is
    // for testing a broker's behaviour on one, which is not what this console is for.
    protocolVersion: 'auto',
    webSocketPath: isWebSocket(form.scheme) ? form.webSocketPath.trim() || null : null,
    cleanSession: form.cleanSession,
    sessionExpiryInterval: sessionExpiry(form),
    tls: isEncrypted(form.scheme) && hasTlsMaterial(form) ? tlsOptions(form) : null,
  };
}

/**
 * Seconds, or nothing.
 *
 * Nothing whenever the field could not apply — a kept session is what the number is about, and
 * 3.1.1 has no field to put it in — because the API refuses a v3 request that carries one, and
 * a reader who typed a number into a box, then chose 3.1.1 for an unrelated reason, should not
 * have their connect fail over a field the form has since stopped showing them.
 */
function sessionExpiry(form: BrokerForm): number | null {
  // Auto tries 5.0 first and against nearly every broker in service that is what it gets, so a
  // field that only means something on 5.0 is offered rather than hidden. A broker that steps
  // the connection down to 3.x ignores it, which is the same outcome as not sending it.
  if (form.cleanSession) return null;

  const seconds = Number(form.sessionExpiry.trim());

  return form.sessionExpiry.trim() === '' || !Number.isFinite(seconds) || seconds < 0
    ? null
    : Math.floor(seconds);
}

/** The encryption block as the API takes it, whether or not anything is in it. */
function tlsOptions(form: BrokerForm): TlsOptions {
  return {
    allowUntrustedCertificates: form.allowUntrusted,
    certificateAuthorityPath: form.caPath.trim() || null,
    clientCertificatePath: form.clientCertPath.trim() || null,
    clientCertificateKeyPath: form.clientKeyPath.trim() || null,
    // Not trimmed: a password is whatever it is, spaces included.
    clientCertificatePassword: form.clientCertPassword || null,
    sniHost: form.sniHost.trim() || null,
    alpnProtocol: form.alpnProtocol.trim() || null,
  };
}

/**
 * Whether anything under Encryption has been filled in.
 *
 * Two callers, one question. The request needs it to decide whether to send a TLS block at all,
 * and the panel needs it because filling any of these in is a statement that this connection is
 * encrypted — there is no certificate authority for a connection with no certificate in it.
 *
 * The rule only runs that way. The absence of a certificate says nothing at all: nine of the ten
 * encrypted brokers this console ships a preset for present a publicly trusted certificate and
 * need nothing configured for it.
 */
export function hasTlsMaterial(form: BrokerForm): boolean {
  const options = tlsOptions(form);

  return (
    options.allowUntrustedCertificates ||
    Object.values(options).some((value) => typeof value === 'string' && value.length > 0)
  );
}

/** The last connection that worked, back in the form. Neither password comes back with it. */
export function formFromSaved(saved: SavedConnection): BrokerForm {
  return {
    scheme: schemeOf(saved.transport, saved.useTls),
    host: saved.host,
    port: saved.port,
    clientId: saved.clientId,
    username: saved.username ?? '',
    password: '',
    webSocketPath: saved.webSocketPath ?? '',
    // The saved version is deliberately not read back. A connection saved when this console
    // still asked which MQTT to speak would otherwise pin a version nothing on screen mentions.
    cleanSession: saved.cleanSession,
    sessionExpiry: saved.sessionExpiryInterval == null ? '' : String(saved.sessionExpiryInterval),
    allowUntrusted: saved.tls?.allowUntrustedCertificates ?? false,
    caPath: saved.tls?.certificateAuthorityPath ?? '',
    clientCertPath: saved.tls?.clientCertificatePath ?? '',
    clientKeyPath: saved.tls?.clientCertificateKeyPath ?? '',
    clientCertPassword: '',
    sniHost: saved.tls?.sniHost ?? '',
    alpnProtocol: saved.tls?.alpnProtocol ?? '',
  };
}

// A scheme, any scheme, in front of the rest. Only used to tell the two things
// `parseBrokerAddress` returns null for apart from each other: a bare hostname, which belongs
// in the box as the host it is, and a scheme this console has no transport for, which must move
// nothing at all.
const SCHEMED = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/**
 * The Broker address box's text, reconciled with the form.
 *
 * Pure, and that is the point of it. The panel calls this on the paste, on the way out of the
 * box, AND when Connect is pressed, using the returned form for the request directly — so there
 * is no ordering in which the box shows one broker and the attempt goes to another.
 *
 * What the address does not say is left as it stands rather than reset: pasting `mqtts://host`
 * over a port somebody typed moves the port exactly as far as pressing the `mqtts` chip would,
 * and no further.
 */
export function applyAddress(form: BrokerForm, text: string): BrokerForm {
  const parsed = parseBrokerAddress(text);

  if (!parsed) {
    // A scheme this console has no transport for. Nothing moves — including the host, which is
    // the half of `foo://host` that looks safe to keep and is not: it would leave the box
    // reading `mqtt://host` for an address whose scheme was just refused.
    if (SCHEMED.test(text.trim())) return form;

    // Everything else with no scheme, no port and no path is a hostname, and belongs in the box
    // as the host it is. An empty box is an empty host: the reader cleared it, and the API's
    // refusal says more about that than a value put back would.
    return { ...form, host: text.trim() };
  }

  // A scheme the address named wins outright. One it did not name, but whose port implies, gets
  // the same inference the Port box makes on the way out — an address box and a port box that
  // disagreed about what 8883 means would be two answers to one question.
  const scheme =
    parsed.scheme ??
    (parsed.port === undefined ? form.scheme : schemeForPort(form.scheme, parsed.port));

  return {
    ...form,
    scheme,
    host: parsed.host,
    port: parsed.port ?? portFor(form.scheme, scheme, form.port),
    webSocketPath: parsed.webSocketPath ?? form.webSocketPath,
  };
}
