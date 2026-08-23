import { describe, expect, it } from 'vitest';
import { buildConnectRequest, formFromSaved, type BrokerForm } from './brokerForm';
import { SCHEMES, portFor, schemeForPort, schemeOf, versionName } from './scheme';
import type { SavedConnection } from '../../types/api';

const FORM: BrokerForm = {
  scheme: 'mqtt',
  host: 'broker.local',
  port: 1883,
  clientId: 'console',
  username: '',
  password: '',
  webSocketPath: '',
  protocolVersion: 'auto',
  cleanSession: true,
  sessionExpiry: '',
  allowUntrusted: false,
  caPath: '',
  clientCertPath: '',
  clientKeyPath: '',
  clientCertPassword: '',
  sniHost: '',
  alpnProtocol: '',
};

describe('the scheme, as the API sees it', () => {
  it.each([
    ['mqtt', 'tcp', false],
    ['mqtts', 'tcp', true],
    ['ws', 'webSocket', false],
    ['wss', 'webSocket', true],
  ] as const)('sends %s as %s with useTls %s', (scheme, transport, useTls) => {
    const request = buildConnectRequest({ ...FORM, scheme });

    expect(request.transport).toBe(transport);
    expect(request.useTls).toBe(useTls);
  });

  // The two halves have to survive the round trip, or a saved connection reopens as a different
  // one — which is how a wss:// broker would come back as mqtts:// and fail on a port nothing
  // encrypted is listening on.
  it('reads back every scheme it can write', () => {
    SCHEMES.forEach((choice) => expect(schemeOf(choice.transport, choice.useTls)).toBe(choice.scheme));
  });
});

describe('fields that belong to a scheme the reader has moved away from', () => {
  // Not merely ignored: dropped. Whatever is sent is what gets saved, and a path saved against
  // a TCP connection reappears the next time the panel opens — on a connection that then failed,
  // looking exactly like the reason.
  it('drops a WebSocket path on a TCP scheme', () => {
    expect(buildConnectRequest({ ...FORM, scheme: 'mqtt', webSocketPath: '/mqtt' }).webSocketPath)
      .toBeNull();
  });

  it('keeps the path where there is a WebSocket to put it on', () => {
    expect(buildConnectRequest({ ...FORM, scheme: 'wss', webSocketPath: '/mqtt' }).webSocketPath)
      .toBe('/mqtt');
  });

  it('drops the encryption block on an unencrypted scheme', () => {
    expect(buildConnectRequest({ ...FORM, scheme: 'ws', caPath: '/ca.crt' }).tls).toBeNull();
  });

  it('sends nothing at all when the encryption fields were never touched', () => {
    expect(buildConnectRequest({ ...FORM, scheme: 'mqtts' }).tls).toBeNull();
  });

  it('sends the block once anything in it is filled in', () => {
    expect(buildConnectRequest({ ...FORM, scheme: 'mqtts', caPath: '/ca.crt' }).tls).toMatchObject({
      certificateAuthorityPath: '/ca.crt',
    });
  });

  // A box that was ticked and nothing else is still something the reader asked for.
  it('sends the block for the one field that is not a path', () => {
    expect(buildConnectRequest({ ...FORM, scheme: 'mqtts', allowUntrusted: true }).tls)
      .toMatchObject({ allowUntrustedCertificates: true });
  });
});

describe('session expiry, which only one version has', () => {
  const kept = { ...FORM, cleanSession: false };

  it('is sent when a session is being kept on a version that has the field', () => {
    expect(buildConnectRequest({ ...kept, sessionExpiry: '600' }).sessionExpiryInterval).toBe(600);
  });

  // The API refuses a 3.x request carrying one. A reader who typed a number and then chose
  // 3.1.1 for an unrelated reason should not have their connect fail over a field the form has
  // since stopped showing them.
  it('is dropped on a version with nowhere to put it', () => {
    expect(
      buildConnectRequest({ ...kept, protocolVersion: 'v311', sessionExpiry: '600' })
        .sessionExpiryInterval,
    ).toBeNull();
  });

  // The number is about a session that outlives the link. With a clean start there is none.
  it('is dropped when the session is not being kept', () => {
    expect(
      buildConnectRequest({ ...FORM, cleanSession: true, sessionExpiry: '600' })
        .sessionExpiryInterval,
    ).toBeNull();
  });

  it('says nothing for an empty box, rather than zero', () => {
    expect(buildConnectRequest(kept).sessionExpiryInterval).toBeNull();
  });

  it('says zero when zero was typed, which is a different instruction', () => {
    expect(buildConnectRequest({ ...kept, sessionExpiry: '0' }).sessionExpiryInterval).toBe(0);
  });
});

describe('a saved connection, back in the form', () => {
  const SAVED: SavedConnection = {
    host: 'broker.example',
    port: 8084,
    clientId: 'saved',
    username: 'alice',
    hasPassword: true,
    useTls: true,
    transport: 'webSocket',
    protocolVersion: 'v311',
    webSocketPath: '/paho',
    cleanSession: false,
    sessionExpiryInterval: 300,
    tls: {
      allowUntrustedCertificates: false,
      certificateAuthorityPath: '/ca.crt',
      clientCertificatePath: '/client.pfx',
      clientCertificateKeyPath: null,
      hasClientCertificatePassword: true,
      sniHost: 'real.example',
      alpnProtocol: null,
    },
  };

  it('comes back as the scheme it was made with', () => {
    expect(formFromSaved(SAVED).scheme).toBe('wss');
  });

  it('brings everything the API kept', () => {
    expect(formFromSaved(SAVED)).toMatchObject({
      host: 'broker.example',
      port: 8084,
      webSocketPath: '/paho',
      protocolVersion: 'v311',
      cleanSession: false,
      sessionExpiry: '300',
      caPath: '/ca.crt',
      clientCertPath: '/client.pfx',
      sniHost: 'real.example',
    });
  });

  // Neither password is ever returned, and neither is guessed at.
  it('leaves both passwords empty', () => {
    expect(formFromSaved(SAVED)).toMatchObject({ password: '', clientCertPassword: '' });
  });

  it('survives a connection that never touched the encryption fields', () => {
    expect(formFromSaved({ ...SAVED, tls: null })).toMatchObject({
      caPath: '',
      clientCertPath: '',
      allowUntrusted: false,
    });
  });
});

describe('the port a scheme change lands on', () => {
  // A number somebody typed is theirs. This is the whole of the rule, and the reason the
  // picker is safe to press while a lab broker on a strange port is in the box.
  it('leaves a typed port alone', () => {
    expect(portFor('mqtt', 'mqtts', 21883)).toBe(21883);
  });

  it('moves a port the old scheme filled in by itself', () => {
    expect(portFor('mqtt', 'mqtts', 1883)).toBe(8883);
    expect(portFor('mqtts', 'wss', 8883)).toBe(8084);
    expect(portFor('wss', 'mqtt', 8084)).toBe(1883);
  });
});

describe('the scheme a port implies', () => {
  it('turns encryption on for the encrypted default of the same transport', () => {
    expect(schemeForPort('mqtt', 8883)).toBe('mqtts');
    expect(schemeForPort('ws', 8084)).toBe('wss');
  });

  it('turns it off again for the plain default', () => {
    expect(schemeForPort('mqtts', 1883)).toBe('mqtt');
    expect(schemeForPort('wss', 8083)).toBe('ws');
  });

  // The rule that keeps this from undoing a choice rather than correcting a mistake: 8883 over
  // a WebSocket is a configuration brokers really run, and somebody on wss picked the WebSocket
  // deliberately.
  it('never crosses the transport', () => {
    expect(schemeForPort('wss', 8883)).toBe('wss');
    expect(schemeForPort('mqtts', 8084)).toBe('mqtts');
  });

  it("leaves a port that is nobody's default alone", () => {
    expect(schemeForPort('mqtt', 21883)).toBe('mqtt');
    expect(schemeForPort('mqtts', 0)).toBe('mqtts');
  });
});

describe('how a version reads', () => {
  it('names a version as a version', () => {
    expect(versionName('v500')).toBe('MQTT 5.0');
    expect(versionName('v310')).toBe('MQTT 3.1');
  });

  // Auto is not one, and a link never reports it — this is for the failure sentences, where
  // the attempt is what is being described.
  it('says what Auto is instead of naming a number', () => {
    expect(versionName('auto')).toBe('whichever version fits');
  });
});
