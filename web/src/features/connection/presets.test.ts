import { describe, expect, it } from 'vitest';
import { BROKER_PRESETS, CLOUD_PRESETS, PUBLIC_PRESETS, type BrokerPreset } from './presets';
import { SCHEMES, isEncrypted, isWebSocket } from './scheme';

// The chip is keyed by name, and the panel decides which chip is lit by comparing it.
describe('the presets as a set', () => {
  it('names each one exactly once', () => {
    const names = BROKER_PRESETS.map((p) => p.name);

    expect(new Set(names).size).toBe(names.length);
  });

  it('offers more than one broker to choose between', () => {
    expect(BROKER_PRESETS.length).toBeGreaterThan(1);
  });
});

describe('what each preset promises', () => {
  const each = (assert: (preset: BrokerPreset) => void) =>
    BROKER_PRESETS.forEach((preset) => assert(preset));

  it('carries a filter to listen to, not just an address', () => {
    each((preset) => expect(preset.onConnectFilter.trim()).not.toBe(''));
  });

  it('says what the broker is', () => {
    each((preset) => expect(preset.note.trim()).not.toBe(''));
  });

  // The failure this whole feature exists downstream of: a bare '#' is refused by every public
  // broker tested, and mqtt.hsl.fi refuses it by closing the session — so the console connected
  // and fell straight over.
  //
  // The rule is about brokers nobody here owns. A cloud preset is a cluster of your own, where
  // what '#' is allowed to reach is a policy you wrote, so it is exempt — and it is exempt by
  // name rather than by slipping through a heuristic, which is the point of testing it this way.
  it('asks a shared broker for a bare # only where a bare # is answerable', () => {
    PUBLIC_PRESETS.forEach((preset) => {
      if (preset.onConnectFilter !== '#') return;

      expect(preset.username).not.toBe('');
    });
  });

  it('asks for a bare # only from a broker somebody here owns', () => {
    each((preset) => {
      if (preset.onConnectFilter !== '#') return;

      const local = preset.host === 'localhost' || preset.host === '127.0.0.1';
      expect(local || preset.cloud === true || preset.username !== '').toBe(true);
    });
  });

  // A preset is a shortcut, and a shortcut that quietly downgrades the connection is a trap.
  it('never puts TLS on a port that does not speak it', () => {
    each((preset) => {
      if (!isEncrypted(preset.scheme)) return;

      expect(preset.port).not.toBe(1883);
    });
  });

  it('names a scheme the panel offers', () => {
    const offered = SCHEMES.map((s) => s.scheme);

    each((preset) => expect(offered).toContain(preset.scheme));
  });

  // A path is what a WebSocket connection is dialled on; on TCP there is nowhere to put one,
  // and a preset carrying one would be describing a connection it does not make.
  it('carries a path only where there is a WebSocket to put it on', () => {
    each((preset) => {
      if (preset.webSocketPath === undefined) return;

      expect(isWebSocket(preset.scheme)).toBe(true);
      expect(preset.webSocketPath.startsWith('/')).toBe(true);
    });
  });

  // The one thing that makes a cloud preset different from every other: the address is the
  // reader's, and leaving a host in would send them to somebody else's account.
  it('leaves a cloud service its own address to fill in', () => {
    CLOUD_PRESETS.forEach((preset) => expect(preset.host).toBe(''));
  });

  // Presets are shipped source, readable by anyone who has the binary.
  it('carries no password', () => {
    each((preset) => expect(preset).not.toHaveProperty('password'));
  });
});
