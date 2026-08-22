import { describe, expect, it } from 'vitest';
import { BROKER_PRESETS, type BrokerPreset } from './presets';

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
  // and fell straight over. A preset may only ask for '#' where something makes it work.
  it('asks for a bare # only where a bare # is answerable', () => {
    each((preset) => {
      if (preset.onConnectFilter !== '#') return;

      const local = preset.host === 'localhost' || preset.host === '127.0.0.1';
      expect(local || preset.username !== '').toBe(true);
    });
  });

  // A preset is a shortcut, and a shortcut that quietly downgrades the connection is a trap.
  it('never puts TLS on a port that does not speak it', () => {
    each((preset) => {
      if (!preset.useTls) return;

      expect(preset.port).not.toBe(1883);
    });
  });

  // Presets are shipped source, readable by anyone who has the binary.
  it('carries no password', () => {
    each((preset) => expect(preset).not.toHaveProperty('password'));
  });
});
