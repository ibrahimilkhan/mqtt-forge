import { vi } from 'vitest';

/** One beep that was actually started: what it sounded at, and when. */
export type Tone = { hz: number; at: number };

export type FakeAudio = {
  /** Every beep started since the stub was installed, oldest first. */
  tones: Tone[];
  /** What the context says it is doing. A real one will not leave 'suspended' without a gesture. */
  state: () => 'running' | 'suspended';
};

/**
 * A stubbed `AudioContext`, because a test must never construct a real one.
 *
 * jsdom has no WebAudio at all, so the code under test would take its "no sound here" branch and
 * every assertion about a tone would pass by never being reached. This is the smallest object the
 * player actually touches — an oscillator with a frequency, a gain with two ramps, and a
 * destination to connect to — and it records the frequency and the start time of every beep, which
 * is the only observable a tone has.
 *
 * `suspended` is the state a browser starts one in before the page has been clicked;
 * `refuseResume` is the browser that will not leave it, which is the state rule 5 is about.
 */
export function fakeAudio(options: { suspended?: boolean; refuseResume?: boolean } = {}): FakeAudio {
  const tones: Tone[] = [];
  let state: 'running' | 'suspended' = options.suspended ? 'suspended' : 'running';

  // Every AudioParam the player uses, and nothing else: it sets a value and ramps it twice.
  const param = () => ({
    value: 0,
    setValueAtTime: () => {},
    linearRampToValueAtTime: () => {},
  });

  class FakeAudioContext {
    currentTime = 0;
    destination = {};

    get state() {
      return state;
    }

    resume() {
      if (!options.refuseResume) state = 'running';
      return Promise.resolve();
    }

    close() {
      return Promise.resolve();
    }

    createOscillator() {
      const tone: Tone = { hz: 0, at: 0 };

      return {
        type: 'sine',
        frequency: {
          ...param(),
          setValueAtTime: (hz: number) => {
            tone.hz = hz;
          },
        },
        connect: () => {},
        // Recorded on start rather than on creation: an oscillator that was built and never
        // started made no sound, and a test that counted those would pass on a silent console.
        start: (at: number) => {
          tone.at = at;
          tones.push(tone);
        },
        stop: () => {},
      };
    }

    createGain() {
      return { gain: param(), connect: () => {} };
    }
  }

  vi.stubGlobal('AudioContext', FakeAudioContext);

  return { tones, state: () => state };
}
