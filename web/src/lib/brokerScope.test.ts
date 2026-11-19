import { describe, expect, it } from 'vitest';
import type { BrokerLink, SavedProfile } from '../types/api';
import { addressKey, isAddressKey, scopeOf } from './brokerScope';

const link = (host: string, profileId: string | null = null, port = 1883): BrokerLink =>
  ({ host, port, useTls: false, transport: 'tcp', profileId }) as BrokerLink;

const saved = (id: string, name: string, host: string): SavedProfile =>
  ({ id, name, connection: { host, port: 1883, useTls: false, transport: 'tcp' } }) as SavedProfile;

describe('addressKey', () => {
  it('writes the scheme the link was made over', () => {
    expect(addressKey({ host: 'b.example', port: 8883, useTls: true, transport: 'tcp' })).toBe('mqtts://b.example:8883');
    expect(addressKey({ host: 'b.example', port: 443, useTls: true, transport: 'webSocket' })).toBe('wss://b.example:443');
    expect(addressKey({ host: 'b.example', port: 80, useTls: false, transport: 'webSocket' })).toBe('ws://b.example:80');
  });

  // DNS is not case-sensitive, so one broker typed two ways is still one broker.
  it('does not tell a host apart by its case', () => {
    expect(addressKey(link(' Broker.Example '))).toBe(addressKey(link('broker.example')));
  });

  it('keeps an IPv6 literal readable', () => {
    expect(addressKey(link('::1'))).toBe('mqtt://[::1]:1883');
  });

  it('is never mistaken for a saved id', () => {
    expect(isAddressKey(addressKey(link('b.example')))).toBe(true);
    expect(isAddressKey('3f2c9a0e5b7d4e1f8a6c2b9d0e4f7a1c')).toBe(false);
  });
});

describe('scopeOf', () => {
  const profiles = [saved('lab-1', 'Lab', 'lab.example'), saved('lab-2', 'Lab again', 'lab.example')];

  it('answers to its saved id, every saved entry at its address, and the address', () => {
    expect(scopeOf(link('lab.example', 'lab-2'), profiles)).toEqual({
      own: 'lab-2',
      keys: ['lab-2', 'lab-1', 'mqtt://lab.example:1883'],
      name: 'Lab again',
    });
  });

  // Dialled from the history: nothing on the link says it is saved, and the address does.
  it('finds the saved broker a link was not dialled from', () => {
    expect(scopeOf(link('lab.example'), profiles)).toMatchObject({ own: 'lab-1', name: 'Lab' });
  });

  it('names a broker that was never saved by its address', () => {
    expect(scopeOf(link('typed.example'), profiles)).toEqual({
      own: 'mqtt://typed.example:1883',
      keys: ['mqtt://typed.example:1883'],
      name: 'mqtt://typed.example:1883',
    });
  });

  it('tells two ports on one host apart', () => {
    expect(scopeOf(link('lab.example', null, 1884), profiles).own).toBe('mqtt://lab.example:1884');
  });
});
