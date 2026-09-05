import { describe, expect, it } from 'vitest';
import { formatBrokerAddress, formatEndpoint, parseBrokerAddress } from './address';

// What a reader actually has in their hand is one string off a documentation page. These are the
// shapes those strings come in.
describe('an address pasted into the Host box', () => {
  it('takes a full URL apart', () => {
    expect(parseBrokerAddress('mqtts://broker.hivemq.com:8883')).toEqual({
      scheme: 'mqtts',
      host: 'broker.hivemq.com',
      port: 8883,
      webSocketPath: undefined,
    });
  });

  it('keeps the path a WebSocket endpoint carries', () => {
    expect(parseBrokerAddress('wss://broker.emqx.io:8084/mqtt')).toMatchObject({
      scheme: 'wss',
      host: 'broker.emqx.io',
      port: 8084,
      webSocketPath: '/mqtt',
    });
  });

  it('leaves the port out when the address does not name one', () => {
    expect(parseBrokerAddress('mqtt://localhost')).toMatchObject({
      scheme: 'mqtt',
      host: 'localhost',
      port: undefined,
    });
  });

  it('takes a host and port with no scheme in front of them', () => {
    expect(parseBrokerAddress('broker.example:1883')).toMatchObject({
      scheme: undefined,
      host: 'broker.example',
      port: 1883,
    });
  });

  // The names the other clients' documentation uses for the same four ways in.
  it.each([
    ['tcp://host:1883', 'mqtt'],
    ['ssl://host:8883', 'mqtts'],
    ['mqtt+ssl://host:8883', 'mqtts'],
    ['https://host:443/mqtt', 'wss'],
    ['http://host:8083/mqtt', 'ws'],
  ])('reads %s as %s', (text, scheme) => {
    expect(parseBrokerAddress(text)).toMatchObject({ scheme });
  });

  it('drops the credentials half of a URL rather than putting a password on screen', () => {
    expect(parseBrokerAddress('mqtts://alice:secret@broker.example:8883')).toMatchObject({
      host: 'broker.example',
      port: 8883,
    });
  });

  it('keeps an IPv6 literal in one piece', () => {
    expect(parseBrokerAddress('mqtt://[::1]:1883')).toMatchObject({ host: '::1', port: 1883 });
  });

  it('drops a query and a fragment, which no broker is dialled with', () => {
    expect(parseBrokerAddress('wss://host:8084/mqtt?token=abc#top')).toMatchObject({
      webSocketPath: '/mqtt',
    });
  });

  it('does not count a lone slash as a path', () => {
    expect(parseBrokerAddress('mqtts://host:8883/')).toMatchObject({ webSocketPath: undefined });
  });

  // Null is the answer that leaves what was typed exactly where it was typed.
  it.each([
    ['a bare hostname', 'broker.example'],
    ['an empty box', '   '],
    ['a scheme this console has no transport for', 'foo://broker.example:1883'],
    ['a port no broker listens on', ':1883'],
  ])('says %s is nothing to take apart', (_what, text) => {
    expect(parseBrokerAddress(text)).toBeNull();
  });

  it('ignores a port outside the sixteen bits a port has', () => {
    expect(parseBrokerAddress('mqtt://host:99999')).toMatchObject({
      host: 'host',
      port: undefined,
    });
  });
});

// A connection string off a broker's dashboard carries the login in it. The credentials used to
// be dropped on the floor, so the dial went out anonymous and came back refused.
describe('credentials in a pasted address', () => {
  it('fills the user and the password from the userinfo half', () => {
    expect(parseBrokerAddress('mqtt://forge:forge-secret@broker.example:1883')).toEqual({
      scheme: 'mqtt',
      host: 'broker.example',
      port: 1883,
      webSocketPath: undefined,
      username: 'forge',
      password: 'forge-secret',
    });
  });

  it('takes a user with no password', () => {
    expect(parseBrokerAddress('mqtt://forge@broker.example:1883')).toMatchObject({
      host: 'broker.example',
      username: 'forge',
    });
    expect(parseBrokerAddress('mqtt://forge@broker.example:1883')?.password).toBeUndefined();
  });

  // A password is where the awkward characters live, and a dashboard writes them encoded.
  it('undoes the percent-encoding a URL writes them in', () => {
    expect(parseBrokerAddress('mqtts://a%40b:p%3Ass%2Fword@broker.example:8883')).toMatchObject({
      username: 'a@b',
      password: 'p:ss/word',
    });
  });

  // The last '@' wins, because a username may carry one and a host may not.
  it('splits on the last at-sign, so an email address is a username', () => {
    expect(parseBrokerAddress('mqtt://user@corp.com:secret@broker.example:1883')).toMatchObject({
      host: 'broker.example',
      username: 'user@corp.com',
      password: 'secret',
    });
  });

  it('an address with credentials and nothing else is still taken apart', () => {
    expect(parseBrokerAddress('forge:secret@broker.example')).toMatchObject({
      host: 'broker.example',
      username: 'forge',
      password: 'secret',
    });
  });

  it('leaves an address with no credentials saying nothing about them', () => {
    const parsed = parseBrokerAddress('mqtt://broker.example:1883');
    expect(parsed?.username).toBeUndefined();
    expect(parsed?.password).toBeUndefined();
  });
});

describe('an address written back out', () => {
  it('puts the scheme in front of the host', () => {
    expect(formatBrokerAddress('mqtts', 'broker.hivemq.com')).toBe('mqtts://broker.hivemq.com');
  });

  // What a cloud preset leaves in the box: the port and the path are filled in and the address
  // is yours. It reads as the instruction it is rather than as an empty field.
  it('leaves the scheme standing alone when there is no host yet', () => {
    expect(formatBrokerAddress('mqtts', '')).toBe('mqtts://');
    expect(formatBrokerAddress('mqtt', '   ')).toBe('mqtt://');
  });

  // parseBrokerAddress strips the brackets, and a bare ::1 written back is an address that
  // cannot be read again: it is nothing but colons, and splitPort would take the last one
  // for a port.
  it('puts an IPv6 literal back inside its brackets', () => {
    expect(formatBrokerAddress('mqtt', '::1')).toBe('mqtt://[::1]');
  });

  it('does not bracket one that is already bracketed', () => {
    expect(formatBrokerAddress('mqtt', '[::1]')).toBe('mqtt://[::1]');
  });

  // The whole point of the pair: what this writes, the parser reads back unchanged.
  it.each([
    ['mqtt', 'localhost'],
    ['mqtts', 'broker.hivemq.com'],
    ['ws', '192.168.1.50'],
    ['wss', 'broker.emqx.io'],
    ['mqtt', '::1'],
  ] as const)('round-trips %s://%s', (scheme, host) => {
    expect(parseBrokerAddress(formatBrokerAddress(scheme, host))).toMatchObject({ scheme, host });
  });
});

// The log line is built out of this too — `Connected mqtt://[::1]:1883 · client` — and it is the
// one place the brackets are load-bearing for a reader rather than for the parser.
describe('an endpoint written for a reader', () => {
  it('leaves an ordinary host alone', () => {
    expect(formatEndpoint('broker.local', 1883)).toBe('broker.local:1883');
  });

  it('brackets an IPv6 literal, which is nothing but colons', () => {
    expect(formatEndpoint('::1', 1883)).toBe('[::1]:1883');
    expect(formatEndpoint('fe80::1%en0', 8883)).toBe('[fe80::1%en0]:8883');
  });

  it('does not bracket one that already is', () => {
    expect(formatEndpoint('[::1]', 1883)).toBe('[::1]:1883');
  });
});

describe('an address in a log line', () => {
  it('keeps the port findable beside an IPv6 host', () => {
    expect(`${formatBrokerAddress('mqtt', '::1')}:1883`).toBe('mqtt://[::1]:1883');
  });
});
