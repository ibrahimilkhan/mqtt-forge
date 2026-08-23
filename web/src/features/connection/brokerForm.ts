import type { ConnectRequest, MqttProtocolLevel, SavedConnection, TlsOptions } from '../../types/api';
import { parseBrokerAddress } from './address';
import { choiceOf, isEncrypted, isWebSocket, mayBeV5, portFor, schemeOf, type Scheme } from './scheme';

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
  protocolVersion: MqttProtocolLevel;
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
    protocolVersion: form.protocolVersion,
    webSocketPath: isWebSocket(form.scheme) ? form.webSocketPath.trim() || null : null,
    cleanSession: form.cleanSession,
    sessionExpiryInterval: sessionExpiry(form),
    tls: isEncrypted(form.scheme) ? tlsOptions(form) : null,
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
  if (form.cleanSession || !mayBeV5(form.protocolVersion)) return null;

  const seconds = Number(form.sessionExpiry.trim());

  return form.sessionExpiry.trim() === '' || !Number.isFinite(seconds) || seconds < 0
    ? null
    : Math.floor(seconds);
}

/** The encryption block, or null when nothing in it was filled in. */
function tlsOptions(form: BrokerForm): TlsOptions | null {
  const options: TlsOptions = {
    allowUntrustedCertificates: form.allowUntrusted,
    certificateAuthorityPath: form.caPath.trim() || null,
    clientCertificatePath: form.clientCertPath.trim() || null,
    clientCertificateKeyPath: form.clientKeyPath.trim() || null,
    // Not trimmed: a password is whatever it is, spaces included.
    clientCertificatePassword: form.clientCertPassword || null,
    sniHost: form.sniHost.trim() || null,
    alpnProtocol: form.alpnProtocol.trim() || null,
  };

  const touched =
    options.allowUntrustedCertificates ||
    Object.values(options).some((value) => typeof value === 'string' && value.length > 0);

  return touched ? options : null;
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
    protocolVersion: saved.protocolVersion,
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

  const scheme = parsed.scheme ?? form.scheme;

  return {
    ...form,
    scheme,
    host: parsed.host,
    port: parsed.port ?? portFor(form.scheme, scheme, form.port),
    webSocketPath: parsed.webSocketPath ?? form.webSocketPath,
  };
}
