import { describe, expect, it } from 'vitest';
import { parseBrokerAddress } from './address';

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
